import { describe, expect, it } from 'vitest';
import { LAYOUT_SLOTS } from '@/lib/store-skin';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * ONE PRODUCT CARD, FOUR ARRANGEMENTS.
 *
 * It was written by hand in four places — the front page, the shelf,
 * «يُشترى معه عادةً» and «شوهد مؤخراً» — and three of them had already
 * lost something the fourth had: the «من» prefix, the null-name guard,
 * the initial in a wash instead of a grey square. Four copies is four
 * chances to forget, and the one that forgets is never the one anybody
 * looks at.
 */

const card = () => stripComments(repoFile('src/components/storefront/ProductCard.tsx'));
const css = () => repoFile('src/components/storefront/styles.ts');

/** Everywhere a product card is drawn. */
const SURFACES = [
  'src/app/s/[store]/page.tsx',
  'src/app/s/[store]/shop/page.tsx',
  'src/app/s/[store]/p/[sku]/page.tsx',
  'src/components/storefront/RecentlyViewed.tsx',
];

describe('there is only one of these', () => {
  it.each(SURFACES)('%s draws no card of its own', (file) => {
    const src = stripComments(repoFile(file));
    expect(src, 'بطاقة مكتوبة بيدها').not.toMatch(/className="sf-card"/);
  });

  it.each(SURFACES)('%s uses the one there is', (file) => {
    expect(stripComments(repoFile(file))).toContain('<ProductCard');
  });

  /**
   * And each hands it the shop's chosen variant rather than a favourite
   * of its own — a row that looked different from the grid above it
   * would read as a bug, not as a template.
   */
  it.each(SURFACES.filter((f) => f.startsWith('src/app')))('%s passes the shop’s variant', (file) => {
    expect(stripComments(repoFile(file))).toMatch(/layoutOf\(store\.theme, 'productCard'\)/);
  });
});

describe('what every variant keeps', () => {
  it('a designed empty state, with the product’s initial', () => {
    expect(card()).toMatch(/data-letter=\{letter\}/);
    expect(css()).toMatch(/content: attr\(data-letter\)/);
  });

  /**
   * A missing letter is a dash; a missing shop is an outage. One row with
   * a null name took the whole front page down with «Cannot read
   * properties of undefined».
   */
  it('and survives a product with no name', () => {
    expect(card()).toMatch(/\(product\.name \?\? ''\)\.trim\(\)\.charAt\(0\) \|\| '—'/);
  });

  it('the price, through the one formatter', () => {
    expect(card()).toContain('moneyText(product.fromPrice');
    // Not a `toLocaleString` of its own: the front page had one, which is
    // two decimals wherever the country says otherwise.
    expect(card(), 'منسّق مال ثانٍ').not.toContain('toLocaleString');
  });

  it('and says «من» only when the bundles beat the base price', () => {
    expect(card()).toMatch(/product\.fromPrice < product\.basePrice && <small> من<\/small>/);
  });

  it('and «من» comes after the amount, so the left-to-right pill puts it on the right', () => {
    // Before the amount it drew on the LEFT of «15.00 USD» — read from the
    // right, the pill said the currency, then the number, then «من».
    const src = card();
    expect(src.indexOf('<small> من</small>')).toBeGreaterThan(src.indexOf('moneyText(product.fromPrice'));
  });

  /**
   * A FIXED RATIO. Cards of different heights make a grid that saws up
   * and down the page.
   */
  /**
   * SCOPED TO THE RULE'S OWN BRACES.
   *
   * The first version read a 400-character window after the selector —
   * and a window is satisfied by a NEIGHBOUR's value. Deleting
   * `square`'s ratio left `portrait`'s inside the window and the guard
   * stayed green. Rule by rule, or not at all.
   */
  const rulesFor = (variant: string) =>
    css()
      .split('}')
      .filter((rule) => rule.includes(`data-card='${variant}'`));

  it.each(LAYOUT_SLOTS.productCard)('the «%s» card fixes its image ratio', (variant) => {
    const onTheImage = rulesFor(variant).filter((r) => r.includes('.sf-card-img'));
    expect(onTheImage.length, `${variant}: لا قاعدة على الصورة`).toBeGreaterThan(0);
    expect(
      onTheImage.some((r) => /aspect-ratio:/.test(r)),
      `${variant}: صورة بلا نسبة ثابتة`
    ).toBe(true);
  });

  it('and no variant hides the price or the name', () => {
    for (const part of ['sf-card-price', 'sf-card-name']) {
      expect(css(), part).not.toMatch(new RegExp(`data-card[^{]*\\.${part}[^}]*display:\\s*none`));
    }
  });
});
