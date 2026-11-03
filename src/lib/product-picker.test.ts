import { describe, expect, it } from 'vitest';
import {
  groupProducts,
  matchProducts,
  pickerRows,
  PICKER_LIMIT,
  UNCATEGORISED_LABEL,
  type PickableProduct,
} from '@/components/ui/ProductPicker';
import { repoFile, stripComments } from './guard-source';

/**
 * FINDING ONE PRODUCT OUT OF A HUNDRED.
 *
 * It was a native `<select>` holding every product in the company —
 * measured at the time: 114 of them — so choosing one meant scrolling a
 * dropdown on a phone. Reported twice, from two screens: «لما أضيف منتج
 * بخانة طلب جديد ما بطلع بحث» and «لما أضيف منتج في طلب مرتجع ما بطلع
 * بحث». Both come through one editor, so both are one fix.
 */

const P = (id: string, name: string, sku?: string): PickableProduct => ({ id, name, sku });

const CATALOGUE: PickableProduct[] = [
  P('1', 'قطرة طنين الأذن Cliarden 20 مل', 'EAR-20'),
  P('2', 'كريم البواسير 50 مل', 'HEM-50'),
  P('3', 'كريم بركة لآلام المفاصل 50 مل', 'JNT-50'),
  P('4', 'الصابونة الإفريقية African Black Soap', 'SOAP-100'),
];

describe('the search a hundred products need', () => {
  /**
   * THE WHOLE POINT, AND THE ONE THAT WOULD SILENTLY REGRESS.
   *
   * Arabic is written with and without hamza, and a shopper or an agent
   * types whichever is on the keyboard. `normalizeArabic` — the one the
   * rest of the system already uses — folds أ إ آ into ا, ة into ه and ى
   * into ي, so all three spellings of the same word are the same query.
   */
  it('finds the same product however the hamza is written', () => {
    for (const q of ['الأذن', 'الاذن', 'اذن', 'أذن']) {
      expect(matchProducts(CATALOGUE, q).map((p) => p.id), q).toEqual(['1']);
    }
  });

  it('and ignores the diacritics somebody typed', () => {
    expect(matchProducts(CATALOGUE, 'الأُذُن').map((p) => p.id)).toEqual(['1']);
  });

  it('matches the code too — a warehouse reads the code, not the name', () => {
    expect(matchProducts(CATALOGUE, 'hem-50').map((p) => p.id)).toEqual(['2']);
  });

  it('returns every match, not the first', () => {
    expect(matchProducts(CATALOGUE, 'كريم').map((p) => p.id)).toEqual(['2', '3']);
  });

  it('an empty query opens on the catalogue rather than on nothing', () => {
    expect(matchProducts(CATALOGUE, '')).toHaveLength(CATALOGUE.length);
    expect(matchProducts(CATALOGUE, '   ')).toHaveLength(CATALOGUE.length);
  });

  it('and never draws more than a screenful', () => {
    const many = Array.from({ length: 300 }, (_, i) => P(String(i), `منتج ${i}`));
    expect(matchProducts(many, '').length).toBe(PICKER_LIMIT);
    expect(matchProducts(many, 'منتج').length).toBe(PICKER_LIMIT);
  });

  it('says so when nothing matches, rather than looking broken', () => {
    expect(matchProducts(CATALOGUE, 'zzzz')).toEqual([]);
  });
});

describe('the one editor both screens go through', () => {
  it('uses the picker, not a dropdown of everything', () => {
    const src = stripComments(repoFile('src/components/orders/ProductLinesEditor.tsx'));
    expect(src).toMatch(/<ProductPicker/);
    // The `<select>` that listed all 114 is gone. The offer select below
    // it is a different thing and stays, so this looks for the product one.
    expect(src, 'ما زال يسرد كلَّ المنتجات في قائمة').not.toMatch(
      /<option value="">— اختر المنتج —<\/option>/
    );
  });

  it('and the spelling rule is the system’s one, not a second copy', () => {
    const src = stripComments(repoFile('src/components/ui/ProductPicker.tsx'));
    // One comparison form for every matcher an agent types into: spelling folded AND digits Latin (`foldForMatch`).
    expect(src).toMatch(/import \{ foldForMatch \} from '@\/lib\/order-parser'/);
    // A second set of replace() calls here would be a second answer to
    // «how is أذن spelled», and the two would drift.
    expect(src, 'قاعدةُ إملاءٍ ثانية').not.toMatch(/replace\(\/\[أإآ/);
  });
});

/**
 * «كل المنتجات» IS A CHOICE, AND A FILTER IS NOT A LINE.
 *
 * A line must end up holding a product. A filter starts at «all», has to be
 * able to return there, and must never be forced to hold one just because
 * somebody opened the box. That is one row and one sentinel value, so it is
 * a prop on the picker rather than a second picker — two would be two
 * answers to «how is أذن spelled», which is the fault this component ended.
 */
describe('the row that means «not one product»', () => {
  const ANY = { value: 'all', label: 'كل المنتجات' };

  it('is offered when the caller asks for it', () => {
    expect(pickerRows(CATALOGUE, '', ANY).showAny).toBe(true);
  });

  it('is not offered to a chooser that has no such state', () => {
    // ProductLinesEditor passes no `anyOption`: a line without a product is
    // not a line, so there is nowhere for this row to lead.
    expect(pickerRows(CATALOGUE, '', undefined).showAny).toBe(false);
  });

  /**
   * THE NEGATIVE ONE, AND THE REASON IT EXISTS.
   *
   * Somebody typing «كريم» is looking for a product. «كل المنتجات» sitting
   * above the matches is a row the arrow keys land on first and Enter then
   * chooses — which CLEARS the very filter they are building.
   */
  it('disappears the moment anything is typed', () => {
    expect(pickerRows(CATALOGUE, 'كريم', ANY).showAny).toBe(false);
  });

  it('but blank space is not typing', () => {
    expect(pickerRows(CATALOGUE, '   ', ANY).showAny).toBe(true);
  });

  it('and the rows themselves are still the ordinary search', () => {
    expect(pickerRows(CATALOGUE, 'كريم', ANY).rows.map((p) => p.id)).toEqual(['2', '3']);
    expect(pickerRows(CATALOGUE, '', ANY).rows).toHaveLength(CATALOGUE.length);
  });
});

/**
 * THE THREE DROPDOWNS THAT STILL LISTED EVERY PRODUCT.
 *
 * Measured on the dev database: 114 products, every one ACTIVE and every one
 * carrying a SKU. As a native `<select>` that is 115 rows to scroll on a
 * phone — and the popup a `<select>` opens is drawn by the browser, not by
 * the theme, which is the other half of «لما أجي أختار منتج يتضوي بيضا».
 */
describe('every product dropdown goes through the one picker', () => {
  const CONVERTED = [
    'src/components/screens/OrdersScreen.tsx',
    // The create dialog's product step moved to the wizard on 3/11.
    'src/components/landing-flow/CreateWizard.tsx',
    'src/components/screens/LandingLibraryScreen.tsx',
    'src/components/screens/LandingPageDetailScreen.tsx',
  ] as const;

  it.each(CONVERTED)('%s uses the picker', (file) => {
    expect(stripComments(repoFile(file))).toMatch(/<ProductPicker/);
  });

  it.each(CONVERTED)('%s lists no product as a bare <option>', (file) => {
    const src = stripComments(repoFile(file));
    // `{products.map(p => <option …>)}` in any of its spellings. Other
    // dropdowns on these screens — regions, couriers, sources — are short
    // lists and are deliberately left alone, so this looks for the product
    // one by the variable it iterates.
    expect(src, 'ما زال يسرد كلَّ المنتجات في قائمة').not.toMatch(
      /products[^\n]*\.map\([^)]*\)\s*=>\s*<option/
    );
  });

  /**
   * AND NONE OF THEM ASKS FOR A SLICE OF THE CATALOGUE.
   *
   * `?limit=200` READ as 200 and was capped at 100 by the route
   * (`Math.min(…, 100)` in api/products/route.ts), so two of these screens
   * could reach only 100 of the 114 products. A search box over a truncated
   * list is worse than a dropdown over a whole one: it answers «لا يوجد»
   * about a product that exists.
   */
  it.each(CONVERTED)('%s asks for the whole catalogue', (file) => {
    expect(stripComments(repoFile(file)), 'ما زال يطلب شريحةً من الكتالوج').not.toMatch(
      /api\/products\?[^'"`]*limit=/
    );
  });
});

/**
 * BROWSING, WHICH IS NOT SEARCHING.
 *
 * A flat searchable list wins on «find the product I can name» and LOSES on
 * «show me what we sell» — and somebody opening this box does not always
 * know the name to type. The old `<select>` grouped under `<optgroup>`; the
 * picker draws the same headings, and the query decides which mode is right.
 */
describe('the catalogue under its categories', () => {
  const skin = { id: 'c1', name: 'العناية بالبشرة' };
  const hair = { id: 'c2', name: 'الشعر' };
  const CAT: PickableProduct[] = [
    { id: '1', name: 'كريم أ', category: skin },
    { id: '2', name: 'شامبو', category: hair },
    { id: '3', name: 'منتج بلا صنف' },
    { id: '4', name: 'كريم ب', category: skin },
  ];

  it('groups while nothing has been typed', () => {
    const groups = groupProducts(CAT, '', true)!;
    expect(groups.map((g) => g.label)).toEqual(['الشعر', 'العناية بالبشرة', UNCATEGORISED_LABEL]);
    expect(groups[1].products.map((p) => p.id)).toEqual(['1', '4']);
  });

  /**
   * THE NEGATIVE ONE. Once a person has typed, the ranked matches are the
   * answer and category headings are furniture between them.
   */
  it('does NOT group once a query is typed', () => {
    expect(groupProducts(CAT, 'كريم', true)).toBeNull();
    // Blank space is not typing.
    expect(groupProducts(CAT, '   ', true)).not.toBeNull();
  });

  it('is off unless the caller asks — every existing picker keeps its flat list', () => {
    expect(groupProducts(CAT, '', false)).toBeNull();
  });

  it('puts the products with no category LAST, in a bucket that says so', () => {
    // Not first, and never folded silently into another group: the gap is
    // real and hiding it is how it stays unfixed. Measured on this database:
    // all 114 products have no category at all.
    const groups = groupProducts(CAT, '', true)!;
    expect(groups[groups.length - 1].label).toBe(UNCATEGORISED_LABEL);
    expect(groups[groups.length - 1].products.map((p) => p.id)).toEqual(['3']);
  });

  it('keeps every product — grouping loses none of them', () => {
    const groups = groupProducts(CAT, '', true)!;
    expect(groups.flatMap((g) => g.products).map((p) => p.id).sort()).toEqual(['1', '2', '3', '4']);
  });

  it('draws one honest heading when nothing is categorised, rather than none', () => {
    const none: PickableProduct[] = [{ id: '1', name: 'أ' }, { id: '2', name: 'ب' }];
    const groups = groupProducts(none, '', true)!;
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe(UNCATEGORISED_LABEL);
  });
});
