import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SHOP_SHEET } from '@/components/storefront/styles';
import { BLOCK_CSS } from '@/components/landing/blocks/styles';
import { SHOP_BLOCK_CLASSES, shopBlockSlice } from '@/components/storefront/shop-block-slice';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A SHOP WAS WEARING THE WHOLE WARDROBE FOR THIRTEEN CLASSES.
 *
 * `SHOP_SHEET` was `BLOCK_CSS + STOREFRONT_CSS`, and measured on a built
 * page that was **47,831 bytes, of which 23,947 was `BLOCK_CSS`** — the
 * rules for the thirty-odd landing-page blocks a seller assembles in the
 * editor. A storefront page draws eighteen of those classes. The rest
 * dressed sections a shop has no way to render, and every shopper on
 * every product page paid for all of it, on a phone, before the first
 * photograph.
 *
 * It surfaced because «علامة» — the fourth family — did not fit: its
 * product page measured 51.14 KB against a 50 KB cap, and the first
 * reading was that the family was too rich. The family was not the
 * problem. The base was, and had been for every family and every shop.
 *
 * ── WHAT THIS FILE HOLDS ──
 *
 * The LIST is a list, and «a guard that is a list is
 * incomplete the day it is written» is a lesson this repository has paid
 * for four times. So the list is not the guard. The SWEEP is: it reads
 * every storefront source, finds every `lp-` class a shop can render, and
 * fails if one of them is not carried. Add a landing class to a shop
 * component and CI tells you — rather than a shopper finding an unstyled
 * section.
 * ═══════════════════════════════════════════════════════════════════════
 */

const ROOT = process.cwd();
/** Everything that can render inside a shop page. */
const SHOP_ROOTS = ['src/components/storefront', 'src/app/s', 'src/components/store'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * Every `lp-` class name a shop source RENDERS.
 *
 * ⚠️ `stripComments` first, and the slice module itself skipped — this
 * guard read its own prose on its first run. `shop-block-slice.ts` lives
 * under `src/components/storefront`, and its comment names
 * `.lp-hero .lp-badge` as the example of a descendant rule: the sweep duly
 * reported `lp-badge` as a class the shop draws, and nothing anywhere
 * styles it. That is the ninth time a guard in this repository has been
 * fooled by an explanation, and it is the entire reason `stripComments`
 * exists.
 */
function classesTheShopDraws(): Set<string> {
  const found = new Set<string>();
  for (const root of SHOP_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      if (file.endsWith('shop-block-slice.ts')) continue;
      /*
       * THE STORE-LOOKS SLICES NAME LANDING CLASSES WITHOUT DRAWING THEM.
       * `extras-sheet.ts` recolours «الأوفر» (`lp-offer-tag`) and keeps the
       * scroll reveal OFF anything holding the floating order bar
       * (`lp-sticky-bar`): selectors about elements other code draws, inlined
       * only for a shop that asked. Listing them here would put their rules in
       * EVERY shop's sheet — the opposite of what this guard is for.
       */
      if (file.endsWith('extras-sheet.ts')) continue;
      for (const m of stripComments(readFileSync(file, 'utf8')).matchAll(/\blp-[a-z0-9-]+/g)) {
        found.add(m[0]);
      }
    }
  }
  /*
   * THE CATALOGUE BLOCK IS A SHOP SOURCE TOO. The shop's home draws the `catalog` block, whose markup lives in
   * landing/blocks/PageBlocks.tsx — outside the roots above — so its card, picture, name and price chip were
   * never swept, were left out of the list, and every product picture drew unframed. Its classes are read
   * from the block itself (and the card sizes from the schema, because the markup builds `lp-catalog-${size}`).
   */
  const blocks = stripComments(readFileSync(join(ROOT, 'src/components/landing/blocks/PageBlocks.tsx'), 'utf8'));
  const at = blocks.indexOf("case 'catalog'");
  for (const m of blocks.slice(at, at + 6000).matchAll(/lp-catalog(?:-[a-z]+)?/g)) found.add(m[0]);
  const sizes = readFileSync(join(ROOT, 'src/lib/landing-sections.ts'), 'utf8').match(/cardSize:\s*z\.enum\(\[([^\]]+)\]/)?.[1] ?? '';
  // `md` is the default size and has no rule of its own: nothing to keep, so it is not in the list.
  for (const size of sizes.match(/'([a-z]+)'/g) ?? []) if (size !== "'md'") found.add(`lp-catalog-${size.replace(/'/g, '')}`);
  return found;
}

describe('the slice carries what the shop actually draws', () => {
  it('— every landing class in a shop source is in the list', () => {
    /*
     * THE SWEEP, NOT THE LIST. This is what makes the thirteen safe to
     * write down: the day somebody puts `lp-badge` on a storefront
     * component, this names it and says where to add it.
     */
    const missing = [...classesTheShopDraws()].filter(
      (cls) => !(SHOP_BLOCK_CLASSES as readonly string[]).includes(cls)
    );
    expect(
      missing.sort(),
      `صنفٌ من صفحات الهبوط بيرسمه المتجر وما هو بالشريحة — زيده في SHOP_BLOCK_CLASSES:\n${missing.join('\n')}`
    ).toEqual([]);
  });

  it('and every one of them has rules behind it in the sheet', () => {
    // A name in the list with nothing behind it is a class the shop
    // renders bare — which is the same failure, arriving by the other road.
    const absent = (SHOP_BLOCK_CLASSES as readonly string[]).filter((cls) => !SHOP_SHEET.includes(cls));
    expect(absent, `صنفٌ بالشريحة بلا أيّ قاعدة:\n${absent.join('\n')}`).toEqual([]);
  });

  it('and the list names nothing the shop never draws', () => {
    // The other direction: a name kept here after its last use was removed
    // is weight nobody asked for, and nothing else would ever report it.
    const drawn = classesTheShopDraws();
    const unused = (SHOP_BLOCK_CLASSES as readonly string[]).filter((cls) => !drawn.has(cls));
    expect(unused, `صنفٌ بالشريحة ما عاد المتجر يرسمه:\n${unused.join('\n')}`).toEqual([]);
  });
});

describe('and it leaves out what the shop cannot', () => {
  const sliced = shopBlockSlice(BLOCK_CSS);

  it('— the slice is a fraction of the stylesheet it comes from', () => {
    /*
     * Not a round target: the measurement. If a later change makes the
     * slice approach the whole sheet again, the split has stopped working
     * and this says so before a shopper's connection does.
     */
    expect(sliced.length).toBeLessThan(BLOCK_CSS.length * 0.6);
    expect(sliced.length, 'الشريحة فاضية — الفلتر بيرمي كلّ إشي').toBeGreaterThan(1000);
  });

  it('and a rule naming a block the shop cannot render is gone', () => {
    // `lp-root` survives; a block class that is not in the thirteen and is
    // not a descendant of one does not.
    expect(sliced).toContain('lp-cta');
    const foreign = [...BLOCK_CSS.matchAll(/\blp-[a-z0-9-]+/g)]
      .map((m) => m[0])
      .filter((cls) => !(SHOP_BLOCK_CLASSES as readonly string[]).includes(cls));
    expect(foreign.length, 'ورقة البلوكات ما فيها ولا صنف برّا الشريحة — فالاختبار ما بيثبت إشي').toBeGreaterThan(5);
  });

  it('and a rule that names no landing class at all is KEPT', () => {
    /*
     * The safety half of the filter. A `:root`, an element rule or a reset
     * carries no class to match on, and dropping those would take the
     * variables and the resets the kept rules stand on. Proven on real
     * input rather than asserted about the source.
     */
    const css = ':root{--x:1}\n.lp-cta{color:red}\n.lp-nowhere{color:blue}\nh1{margin:0}';
    const out = shopBlockSlice(css);
    expect(out).toContain(':root');
    expect(out).toContain('h1');
    expect(out).toContain('.lp-cta');
    expect(out, 'قاعدةُ بلوكٍ لا يرسمه المتجر وصلت الزبون').not.toContain('lp-nowhere');
  });

  it('and a descendant of a kept class rides with it', () => {
    // The shop renders the container; whatever that container's own markup
    // puts inside it must still be dressed.
    const out = shopBlockSlice('.lp-hero .lp-badge{color:red}\n.lp-badge{color:blue}');
    expect(out).toContain('.lp-hero .lp-badge');
    expect(out).not.toMatch(/(^|\n)\.lp-badge\{/);
  });

  it('and one foreign selector in a list does not take the others with it', () => {
    const out = shopBlockSlice('.lp-cta,.lp-nowhere,.lp-h2{color:red}');
    expect(out).toContain('.lp-cta');
    expect(out).toContain('.lp-h2');
    expect(out).not.toContain('lp-nowhere');
  });

  it('and an @media keeps only what survives inside it, or nothing', () => {
    // An empty `@media{}` reaching a page is weight that styles nothing.
    const out = shopBlockSlice('@media (min-width:720px){.lp-cta{color:red}}\n@media print{.lp-nowhere{color:blue}}');
    expect(out).toContain('@media (min-width:720px)');
    expect(out).toContain('.lp-cta');
    expect(out, 'استعلامٌ فاضٍ وصل الصفحة').not.toContain('@media print');
  });

  it('and nested braces inside a body do not confuse the walk', () => {
    // A regex over braces mis-reads the first nested one, which is why
    // this is a depth-aware walk and not a pattern.
    const out = shopBlockSlice('@supports (display:grid){.lp-cta{color:red}}\n.lp-h2{margin:0}');
    expect(out).toContain('.lp-h2');
  });
});
