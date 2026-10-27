import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, paletteFor, readableOn } from './landing-theme';
import {
  CHECKOUT_FIELDS,
  COLOR_VAR,
  DEFAULT_STORE_THEME,
  MANDATORY_CHECKOUT_FIELDS,
  cartBarApplies,
  checkoutForPage,
  checkoutOrder,
  headingFont,
  menuFont,
  parseStoreTheme,
  requiredCheckoutFields,
  storeColorsSchema,
  storeThemeSchema,
  storeThemeVars,
  themeForPage,
  type StoreTheme,
} from './store-theme';

const of = (partial: Partial<StoreTheme>): StoreTheme => ({ ...DEFAULT_STORE_THEME, ...partial });

describe('the store owns the colour, and the page inherits it', () => {
  it('a page with no theme of its own wears its store’s', () => {
    const store = of({ accent: '#123456', mood: 'bold' });
    expect(themeForPage(store, null)).toBe(store);
    expect(themeForPage(store, undefined).accent).toBe('#123456');
  });

  it('a page that overrides departs from the store, wholly and legibly', () => {
    const store = of({ accent: '#123456', mood: 'bold', corners: 'sharp' });
    const page = themeForPage(store, { accent: '#abcdef' });
    expect(page.accent).toBe('#abcdef');
    // What it did not override still comes from the store — the override is
    // a departure, not a replacement.
    expect(page.mood).toBe('bold');
    expect(page.corners).toBe('sharp');
  });

  it('drops only the field it cannot read, and keeps the rest of the override', () => {
    const store = of({ accent: '#123456', mood: 'clean', pageImage: '' });
    // A mood this code no longer knows must not repaint the whole page: the
    // seller's background photo and colour are still theirs.
    const page = themeForPage(store, { mood: 'light', accent: '#abcdef', pageImage: '/a/b.webp' } as never);
    expect(page.mood).toBe('clean');
    expect(page.accent).toBe('#abcdef');
    expect(page.pageImage).toBe('/a/b.webp');
  });

  it('carries through nothing that is not a theme field', () => {
    const page = themeForPage(of({ accent: '#123456' }), { evil: 'x' } as never);
    expect((page as unknown as Record<string, unknown>).evil).toBeUndefined();
  });
});

describe('a stored theme that no longer parses', () => {
  it('is the house theme when it is not even JSON', () => {
    expect(parseStoreTheme('}{')).toEqual(DEFAULT_STORE_THEME);
    expect(parseStoreTheme(null)).toEqual(DEFAULT_STORE_THEME);
    expect(parseStoreTheme('"a string"')).toEqual(DEFAULT_STORE_THEME);
  });

  it('keeps what still parses, part by part', () => {
    // A header height this code refuses must not take the shop's colour
    // down with it.
    const stored = JSON.stringify({
      ...DEFAULT_THEME,
      accent: '#0a0b0c',
      header: { height: 9000, sticky: true },
      product: { priceStyle: 'with_compare', showStock: true, discountBadge: false, imageOrder: 'newest_first' },
    });
    const theme = parseStoreTheme(stored);
    expect(theme.accent).toBe('#0a0b0c');
    expect(theme.header?.height).toBe(DEFAULT_STORE_THEME.header?.height);
    expect(theme.product?.showStock).toBe(true);
  });

  it('reads a theme saved before any of this existed', () => {
    // A plain landing theme is a valid store theme; nothing about the shop
    // it did not know about may change.
    const theme = parseStoreTheme(JSON.stringify(DEFAULT_THEME));
    expect(theme.accent).toBe(DEFAULT_THEME.accent);
    expect(theme.checkout?.fieldOrder).toEqual([...CHECKOUT_FIELDS]);
  });
});

describe('the checkout cannot be configured into a broken order', () => {
  it('always requires the four a COD parcel needs, whatever was saved', () => {
    const theme = of({ checkout: { ...DEFAULT_STORE_THEME.checkout!, required: [] } });
    for (const f of MANDATORY_CHECKOUT_FIELDS) {
      expect(requiredCheckoutFields(theme), f).toContain(f);
    }
  });

  it('adds the shop’s own on top', () => {
    const theme = of({ checkout: { ...DEFAULT_STORE_THEME.checkout!, required: ['note'] } });
    expect(requiredCheckoutFields(theme)).toContain('note');
  });

  it('never drops a field an older saved order forgot', () => {
    const theme = of({ checkout: { ...DEFAULT_STORE_THEME.checkout!, fieldOrder: ['phone', 'name'] } });
    const order = checkoutOrder(theme);
    expect(order.slice(0, 2)).toEqual(['phone', 'name']);
    for (const f of CHECKOUT_FIELDS) expect(order, f).toContain(f);
  });

  it('never shows a field twice', () => {
    const theme = of({ checkout: { ...DEFAULT_STORE_THEME.checkout!, fieldOrder: ['name', 'name', 'phone'] } });
    const order = checkoutOrder(theme);
    expect(new Set(order).size).toBe(order.length);
  });

  it('refuses to make the region or the address optional — they are not offered', () => {
    // The guard is that the schema has no way to express it: `required` only
    // ever ADDS, and requiredCheckoutFields unions the mandatory four in.
    const theme = of({ checkout: { ...DEFAULT_STORE_THEME.checkout!, required: ['name'] } });
    expect(requiredCheckoutFields(theme)).toContain('region');
    expect(requiredCheckoutFields(theme)).toContain('address');
  });
});

/**
 * «مش مربوط بصفحة الهبوط» — WHAT A LANDING PAGE'S ORDER FORM TAKES FROM ITS STORE.
 *
 * One resolver, run on the server, handing the form plain answers. These hold what it answers when the seller never
 * opened «الدفع», what it does with what they typed, and that a colour which is not one never reaches a button.
 */
describe('checkoutForPage — the store’s «الدفع», for a landing page', () => {
  const withCheckout = (over: Partial<NonNullable<StoreTheme['checkout']>>) =>
    of({ checkout: { ...DEFAULT_STORE_THEME.checkout!, ...over } });

  it('a store that never opened the tab hands over the whole order, and only the four are required', () => {
    const c = checkoutForPage(DEFAULT_STORE_THEME);
    expect(c.fields).toEqual(['name', 'phone', 'altPhone', 'region', 'address', 'note']);
    expect(c.required).toEqual(['name', 'phone', 'region', 'address']);
    expect(c).toMatchObject({ submitText: '', buttonColor: null, buttonVars: null, thanksMessage: '' });
    // And a theme stored before the checkout existed reads the same way.
    expect(checkoutForPage(parseStoreTheme(JSON.stringify(DEFAULT_THEME)))).toEqual(c);
  });

  it('the four a parcel needs stay required whatever was saved, and the shop’s own are added', () => {
    const c = checkoutForPage(withCheckout({ required: ['note'] }));
    for (const f of MANDATORY_CHECKOUT_FIELDS) expect(c.required, f).toContain(f);
    expect(c.required).toContain('note');
    expect(c.required).not.toContain('altPhone');
    expect(checkoutForPage(withCheckout({ required: [] })).required).toEqual(['name', 'phone', 'region', 'address']);
  });

  it('reads the seller’s own order and words off the stored theme', () => {
    const mine = ['phone', 'name', 'region', 'address', 'note', 'altPhone'];
    const stored = JSON.stringify({
      ...DEFAULT_STORE_THEME,
      checkout: {
        fieldOrder: mine,
        required: ['altPhone'],
        submitText: '  احجز علبتك الآن  ',
        buttonColor: '#ffd400',
        afterOrderMessage: ' وصلنا طلبك — بنتصل فيك اليوم. ',
      },
    });
    const c = checkoutForPage(parseStoreTheme(stored));
    expect(c.fields).toEqual(mine);
    expect(c.required).toEqual(['name', 'phone', 'altPhone', 'region', 'address']);
    expect(c.submitText).toBe('احجز علبتك الآن');
    expect(c.thanksMessage).toBe('وصلنا طلبك — بنتصل فيك اليوم.');
    expect(c.buttonColor).toBe('#ffd400');
  });

  it('a valid colour brings its own measured ink and its own pressed shade — the three the button reads', () => {
    const c = checkoutForPage(withCheckout({ buttonColor: '#ffd400' }));
    expect(c.buttonVars).toEqual({
      '--store-accent': '#ffd400',
      '--store-accent-text': readableOn('#ffd400'),
      '--store-accent-dark': paletteFor({ ...DEFAULT_THEME, accent: '#ffd400' }).accentDark,
    });
    // Measured, not assumed: ink on a yellow, where the house accent takes paper.
    expect(c.buttonVars!['--store-accent-text']).not.toBe(readableOn(DEFAULT_THEME.accent));
    expect(c.buttonVars!['--store-accent-dark']).not.toBe('#ffd400');
    // And nothing else of the palette rides along: the band and the cards keep the page's own.
    expect(Object.keys(c.buttonVars!).sort()).toEqual(['--store-accent', '--store-accent-dark', '--store-accent-text']);
  });

  it('NEGATIVE: a colour that is not #rrggbb is no colour — the button keeps the page’s', () => {
    for (const bad of ['red', '#fff', 'ffd400', '#ffd40', '#ffd4000', '#ggd400', 'url(x)', '', '   ']) {
      const c = checkoutForPage(withCheckout({ buttonColor: bad }));
      expect(c.buttonColor, bad).toBeNull();
      expect(c.buttonVars, bad).toBeNull();
    }
    expect(checkoutForPage(withCheckout({ buttonColor: undefined })).buttonVars).toBeNull();
  });

  it('NEGATIVE: whitespace is not words — it falls back like an empty field', () => {
    const c = checkoutForPage(withCheckout({ submitText: '   ', afterOrderMessage: '\n\t ' }));
    expect(c.submitText).toBe('');
    expect(c.thanksMessage).toBe('');
  });
});

describe('the bottom cart bar belongs to a shop that has a cart', () => {
  it('does not apply to a Single Product store', () => {
    expect(cartBarApplies('SINGLE_PRODUCT')).toBe(false);
  });

  it('applies to a multi-product one', () => {
    expect(cartBarApplies('MULTI_PRODUCT')).toBe(true);
    expect(cartBarApplies(null)).toBe(true);
  });
});

describe('the fonts', () => {
  it('fall back to the body face rather than storing a copy of it', () => {
    const theme = of({ font: 'cairo' });
    expect(headingFont(theme)).toBe('cairo');
    expect(menuFont(theme)).toBe('cairo');
    // Changing the body face must change all three, which a stored copy
    // would quietly prevent.
    expect(headingFont(of({ font: 'amiri' }))).toBe('amiri');
  });

  it('are used when set', () => {
    const theme = of({ font: 'cairo', fonts: { heading: 'lalezar', menu: 'rubik' } });
    expect(headingFont(theme)).toBe('lalezar');
    expect(menuFont(theme)).toBe('rubik');
  });

  it('refuse a face that is not in the library', () => {
    expect(storeThemeSchema.safeParse({ ...DEFAULT_THEME, fonts: { heading: 'comic-sans' } }).success).toBe(false);
  });
});

describe('every colour is a variable', () => {
  it('a colour the seller never named still has a value, from the accent', () => {
    const vars = storeThemeVars(of({ accent: '#b8256e' }));
    expect(vars['--store-accent']).toBe('#b8256e');
    for (const variable of Object.values(COLOR_VAR)) {
      expect(vars[variable], variable).toMatch(/^#|^rgb/);
    }
  });

  it('a named colour wins over the derived one', () => {
    const vars = storeThemeVars(of({ accent: '#b8256e', colors: { textPrimary: '#0000ff', danger: '#ff0000' } }));
    expect(vars['--store-text']).toBe('#0000ff');
    expect(vars['--store-danger']).toBe('#ff0000');
  });

  /**
   * THE GUARD THAT WAS MISSING.
   *
   * «أساسي» · «ثانوي» · «أساسي فاتح» · «ثانوي فاتح» were offered on the
   * theme screen, stored on the shop, and emitted as four variables with
   * zero consumers. Nothing compared the fields a shop may set against the
   * variables a page may read, so nothing noticed for as long as they
   * existed. Both directions, from the schema itself.
   */
  it('every colour a shop can name reaches a variable, and no variable twice', () => {
    const fields = Object.keys(storeColorsSchema.shape).sort();
    expect(fields).toEqual(Object.keys(COLOR_VAR).sort());
    expect(new Set(Object.values(COLOR_VAR)).size).toBe(fields.length);
  });

  /**
   * AND THE OTHER HALF OF THE QUESTION: does the variable reach a page?
   *
   * The guard above asks whether every field reaches a variable. Asking
   * the reverse found three more pickers that change nothing — «نجاح» ·
   * «تحذير» · «خطر» are emitted and no storefront component reads them.
   * They predate this and they have a reader coming (the order and
   * thank-you pages), so they are listed rather than removed — and the
   * list is what a test holds shut. A variable that leaves it must be
   * read; a variable that stays in it must still be unread, so the day
   * the engine reads one, this has to be pruned.
   */
  it('every variable a shop can name is read by a component, or is listed as waiting', () => {
    const AWAITING_CONSUMER = new Set([
      // What the catalogue has not drawn YET. `--store-surface-2` and
      // `--store-price` left the list the day the cart drew a thumbnail's
      // empty state and a line total in them — which is what this list is
      // for: it can only ever get shorter.
      '--store-price-compare', '--store-offer-badge',
      // Older than this work: the order and thank-you pages will read them.
      // `--store-danger` left the list the day the tracking form drew a
      // refusal in it — which is what this list is for.
      '--store-success', '--store-warning',
    ]);

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(join(process.cwd(), 'src'));

    const read = new Set<string>();
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/var\(\s*(--store-[a-z0-9-]+)/g)) {
        read.add(m[1]);
      }
    }

    const emitted = Object.values(COLOR_VAR);
    expect(emitted.filter((v) => !read.has(v) && !AWAITING_CONSUMER.has(v))).toEqual([]);
    // And nothing lingers on the list after something starts reading it.
    expect([...AWAITING_CONSUMER].filter((v) => read.has(v))).toEqual([]);
  });

  it('and setting it actually moves that variable', () => {
    const plain = storeThemeVars(of({ accent: '#b8256e' }));
    for (const [field, variable] of Object.entries(COLOR_VAR)) {
      const named = storeThemeVars(of({ accent: '#b8256e', colors: { [field]: '#123456' } }));
      expect(named[variable], field).toBe('#123456');
      // The negative control: naming one colour moves ONE variable.
      const moved = Object.keys(named).filter((k) => named[k] !== plain[k]);
      expect(moved, field).toEqual([variable]);
    }
  });

  /**
   * What sellers already saved is not lost. The four old names are read
   * onto the roles they always described — at parse time, because the
   * column is JSON and rewriting a seller's colours to fix OUR naming is
   * a write we do not need to make.
   */
  it('reads the four old names onto the roles they described', () => {
    const theme = parseStoreTheme(JSON.stringify({
      ...DEFAULT_THEME,
      colors: { secondary: '#111111', primaryLight: '#eeeeee', secondaryLight: '#777777' },
    }));
    expect(theme.colors).toMatchObject({
      textPrimary: '#111111',
      accentTint: '#eeeeee',
      textSecondary: '#777777',
    });
    const vars = storeThemeVars(theme);
    expect(vars['--store-text']).toBe('#111111');
    expect(vars['--store-accent-tint']).toBe('#eeeeee');
    expect(vars['--store-muted']).toBe('#777777');
  });

  it('keeps the new name when a row carries both', () => {
    const theme = parseStoreTheme(JSON.stringify({
      ...DEFAULT_THEME,
      colors: { secondary: '#111111', textPrimary: '#222222' },
    }));
    expect(theme.colors?.textPrimary).toBe('#222222');
  });

  it('the header height is a variable too, so no component writes a pixel', () => {
    expect(storeThemeVars(of({ header: { height: 96, sticky: true, onFrontPage: true } }))['--store-header-h']).toBe('96px');
  });

  it('refuses a colour that is not one', () => {
    expect(storeThemeSchema.safeParse({ ...DEFAULT_THEME, colors: { textPrimary: 'blue' } }).success).toBe(false);
    expect(storeThemeSchema.safeParse({ ...DEFAULT_THEME, colors: { textPrimary: '#fff' } }).success).toBe(false);
  });
});

describe('the cover image is same-origin, like the page image', () => {
  it('refuses somewhere we do not control', () => {
    expect(
      storeThemeSchema.safeParse({ ...DEFAULT_THEME, home: { sectionOrder: [], coverImage: 'https://e.example/a.png' } })
        .success
    ).toBe(false);
  });

  it('accepts an uploaded path, and empty for none', () => {
    for (const coverImage of ['', '/api/public/media/x/y.webp']) {
      expect(
        storeThemeSchema.safeParse({ ...DEFAULT_THEME, home: { sectionOrder: [], coverImage } }).success,
        coverImage
      ).toBe(true);
    }
  });
});
