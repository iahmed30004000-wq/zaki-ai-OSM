import { z } from 'zod';
import { LAYOUT_SLOTS, effectiveVariant } from './layout-slots';
import { DEFAULT_FAMILY, FAMILY_IDS, familyById, familyOfSkin, type FamilyId } from './store-families';
import {
  DEFAULT_THEME,
  STATE_COLORS,
  fontValueSchema,
  landingThemeSchema,
  paletteFor,
  paletteVars,
  type FontValue,
  type LandingTheme,
  type Palette,
} from './landing-theme';

/**
 * WHAT A STORE LOOKS LIKE — one owner, one record.
 *
 * The colour engine already exists: one accent, a mood, and a palette
 * derived from them (landing-theme.ts). This does NOT replace it. A store's
 * theme IS a landing theme plus the things only a shop has — a header, a
 * footer, how a price is written, what the checkout asks for, whether a
 * cart bar rides at the bottom of the screen, and what order the home page
 * puts its sections in.
 *
 * WHO OWNS A COLOUR. The store does. A landing page used to carry its own
 * theme, and so did the store, which is two answers to "what colour is this
 * shop" — the same mistake as a currency on the organisation AND on the
 * country. A page's theme is now an OVERRIDE: absent by default, and when
 * present it is that one page departing from its store's template, which
 * the editor says out loud. `themeForPage` below is the only place the two
 * are combined.
 *
 * EVERY COLOUR IS A VARIABLE. The eight the seller can name are emitted as
 * CSS custom properties beside the derived ones; nothing is written as a
 * hex literal in a component. A colour left unset is not a blank — it is
 * the palette's own, derived from the accent, so a seller who sets one
 * colour gets a coherent shop rather than seven holes.
 */

// ─────────────────────────────────────────────────────
// The pieces
// ─────────────────────────────────────────────────────

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'لون غير صالح');

/**
 * The three typefaces of tab «عام».
 *
 * The base `font` on the landing theme stays what it always was: the body
 * face, and the fallback for the other two. Headings and menus are
 * departures from it, so they are absent until the seller sets them —
 * storing a copy of the body font in all three would make changing the body
 * font change nothing.
 */
export const storeFontsSchema = z.object({
  heading: fontValueSchema.optional(),
  menu: fontValueSchema.optional(),
});

/**
 * The named colours. Each optional, each falling back to the derived
 * palette — see storePalette below.
 */
export const storeColorsSchema = z.object({
  /** The page's own paper. The first surface. */
  background: hex.optional(),
  success: hex.optional(),
  warning: hex.optional(),
  danger: hex.optional(),
  /**
   * A pale wash of the accent: a badge's background, a selected row.
   *
   * This was «أساسي فاتح» and it was one of four pickers writing variables
   * that nothing read. See `migrateLegacyColors`.
   */
  accentTint: hex.optional(),
  // ── named by role: the five that were derived-only, and could not be
  //    said at all by a shop or a template that wanted to say them ──
  /** The card's own colour, against the page behind it. */
  surface1: hex.optional(),
  /** The ink. */
  textPrimary: hex.optional(),
  /** The quieter ink: a hint, a label, a struck-through price. */
  textSecondary: hex.optional(),
  /** Rules and outlines. */
  border: hex.optional(),
  /**
   * What is written ON the accent — a primary button's own text.
   *
   * Derived by measurement (`readableOn`) and right almost always. Named
   * here for the almost: a brand whose button must carry its second colour
   * rather than ink or paper. The contrast rule still applies to it.
   */
  accentContrast: hex.optional(),

  // ── the four a catalogue needs and a landing page never did ──
  /**
   * The third surface: a sort bar, a filter sheet, a strip behind a row.
   *
   * A landing page is one column of blocks on paper, so two surfaces were
   * enough. A product grid is three layers — the page, the card, and the
   * things that are neither — and the third had nowhere to come from.
   */
  surface2: hex.optional(),
  /** The price's own ink. The page's text colour until a shop says otherwise. */
  price: hex.optional(),
  /** The struck-through price beside it. */
  priceCompare: hex.optional(),
  /**
   * The «-20%» badge.
   *
   * Separate from `danger` on purpose. In most palettes they are the same
   * red, and in a shop whose brand IS red they must not be: a discount is
   * good news, and it cannot be painted in the colour that means a failure.
   */
  offerBadge: hex.optional(),
});

/**
 * EVERY COLOUR A SHOP CAN NAME, AND THE VARIABLE IT WRITES.
 *
 * One table, and `storeThemeVars` walks it. A field that is in the schema
 * and not in here reaches no page, and the guard in store-theme.test.ts
 * compares the two lists in both directions — because for as long as this
 * table did not exist, four fields were in the schema, on the screen, and
 * in the database, and reached nothing at all.
 *
 * The accent is not here. It is not a named colour: it is `theme.accent`,
 * the one colour every other is derived from, and it sits on the landing
 * theme with its own control on the screen.
 */
export const COLOR_VAR = Object.freeze({
  background: '--store-page',
  surface1: '--store-card',
  surface2: '--store-surface-2',
  textPrimary: '--store-text',
  textSecondary: '--store-muted',
  border: '--store-border',
  accentTint: '--store-accent-tint',
  accentContrast: '--store-accent-text',
  price: '--store-price',
  priceCompare: '--store-price-compare',
  offerBadge: '--store-offer-badge',
  success: '--store-success',
  warning: '--store-warning',
  danger: '--store-danger',
});

/**
 * THE FOUR NAMES THAT ARE NOW ROLES.
 *
 * `primary` was the accent — a second control for a colour the screen
 * already had a picker for, three rows above it. `secondary` was the ink,
 * `primaryLight` the accent's wash, `secondaryLight` the muted ink. All
 * four wrote variables no component ever read.
 *
 * Read-time, not a migration: the column is JSON, the rows are a seller's
 * own colours, and rewriting them in place to fix OUR naming is a write we
 * do not need to make. A row that has both the old key and the new one
 * keeps the new one — the old is what it was before somebody set the new.
 */
const LEGACY_COLOR: Readonly<Record<string, string>> = Object.freeze({
  secondary: 'textPrimary',
  primaryLight: 'accentTint',
  secondaryLight: 'textSecondary',
});

export function migrateLegacyColors(row: Record<string, unknown>): Record<string, unknown> {
  const colors = row.colors;
  if (!colors || typeof colors !== 'object') return row;

  const from = colors as Record<string, unknown>;
  const to: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(from)) {
    if (key === 'primary') continue; // handled below — it is the accent
    to[LEGACY_COLOR[key] ?? key] = key in LEGACY_COLOR && LEGACY_COLOR[key] in from
      ? from[LEGACY_COLOR[key]]
      : value;
  }

  // `primary` becomes the accent only where the shop never set one of its
  // own. `accent` is required by the landing theme and so is almost always
  // present; the case this catches is a row written before it was.
  const out: Record<string, unknown> = { ...row, colors: to };
  if (typeof from.primary === 'string' && typeof row.accent !== 'string') {
    out.accent = from.primary;
  }
  return out;
}

/**
 * WHICH VARIANT OF EACH ENGINE COMPONENT THIS SHOP WEARS.
 *
 * Declared on the template contract in store-skin.ts since Stage 1, and
 * until now it landed nowhere: `skinToStoreTheme` wrote colours and
 * typefaces and dropped the layout, so a template could be installed and
 * still look like every other one.
 *
 * The vocabulary is `LAYOUT_SLOTS`, imported rather than repeated. A
 * second copy is how a template comes to name a variant no renderer has —
 * and the page then draws nothing, or the default, and nobody finds out
 * from the code.
 *
 * Every slot is optional: a shop that predates this wears the defaults,
 * which are the variants the storefront already drew.
 */
export const storeLayoutSchema = z
  .object({
    header: z.enum(LAYOUT_SLOTS.header).optional(),
    hero: z.enum(LAYOUT_SLOTS.hero).optional(),
    categoryNav: z.enum(LAYOUT_SLOTS.categoryNav).optional(),
    productCard: z.enum(LAYOUT_SLOTS.productCard).optional(),
    categoryPage: z.enum(LAYOUT_SLOTS.categoryPage).optional(),
    productPage: z.enum(LAYOUT_SLOTS.productPage).optional(),
    cart: z.enum(LAYOUT_SLOTS.cart).optional(),
  })
  .strict();

/**
 * What the storefront drew before any of this existed.
 *
 * Named so that «this shop chose the plain header» and «this shop has
 * never chosen» are the same drawing and a different fact — and a
 * renderer never has to ask which.
 */
/** The card variants, named once. */
export type CardVariant = (typeof LAYOUT_SLOTS.productCard)[number];
export type CategoryNavVariant = (typeof LAYOUT_SLOTS.categoryNav)[number];
export type ProductPageVariant = (typeof LAYOUT_SLOTS.productPage)[number];

export const DEFAULT_LAYOUT: Required<z.infer<typeof storeLayoutSchema>> = {
  header: 'minimal',
  hero: 'productFirst',
  categoryNav: 'chips',
  productCard: 'portrait',
  categoryPage: 'grid3',
  productPage: 'galleryTop',
  cart: 'page',
};

export const storeHeaderSchema = z.object({
  /** Bar height in px. Bounded so a header cannot eat the page. */
  height: z.number().int().min(48).max(160).default(72),
  background: hex.optional(),
  /** Stays at the top as the customer scrolls. */
  sticky: z.boolean().default(true),
  /**
   * WORN BY A SINGLE PRODUCT STORE'S FRONT PAGE TOO.
   *
   * Such a store's address renders its landing page, and it used to render
   * it bare: no logo, no shop name, no header, no footer. Everything the
   * seller set under «القوالب» — and the logo under «البلدان والمتاجر» —
   * simply never appeared, on the only page that store has.
   *
   * It is a switch and not a rule because a landing page is also an advert,
   * and a header full of links is a way out of one. The seller decides; the
   * default is to look like the shop it is.
   *
   * Other store types always wear it — their pages are shop pages.
   */
  onFrontPage: z.boolean().default(true),
});

/**
 * The footer's COPYRIGHT — a line of text, and nothing else.
 *
 * Its LINKS used to be here too. The contract named «روابط التذييل» in the
 * template tab and «التذييل» among the five menus, which is one field with
 * two owners — the thing this whole section exists to stop. The links moved
 * to /store/menus (the FOOTER menu), where they gain an order and a
 * visibility flag; migration 20260925130000_store_menus carried over the
 * ones already saved and removed the key from the theme.
 */
export const storeFooterSchema = z.object({
  copyright: z.string().trim().max(160).default(''),
});

export const storeProductSchema = z.object({
  /** How a price is written: the plain number, or struck-through beside it. */
  priceStyle: z.enum(['plain', 'with_compare']).default('plain'),
  /** Show how many are left. Off by default — a low number can lose a sale. */
  showStock: z.boolean().default(false),
  /** A «-20%» badge on a discounted product. */
  discountBadge: z.boolean().default(true),
  imageOrder: z.enum(['as_uploaded', 'newest_first']).default('as_uploaded'),
});

/** The checkout fields a shop may reorder or require. Identity is the phone. */
export const CHECKOUT_FIELDS = ['name', 'phone', 'altPhone', 'region', 'address', 'note'] as const;
export type CheckoutField = (typeof CHECKOUT_FIELDS)[number];

/**
 * Name, phone, region and address are what a parcel needs to arrive and a
 * COD sale needs to be priced. They cannot be made optional from a settings
 * screen, so they are not offered — a shop that could turn the region off
 * would take orders it cannot price or ship.
 */
export const MANDATORY_CHECKOUT_FIELDS: readonly CheckoutField[] = ['name', 'phone', 'region', 'address'];

export const storeCheckoutSchema = z.object({
  fieldOrder: z.array(z.enum(CHECKOUT_FIELDS)).max(CHECKOUT_FIELDS.length).default([...CHECKOUT_FIELDS]),
  /** Beyond the four that are always required. */
  required: z.array(z.enum(CHECKOUT_FIELDS)).max(CHECKOUT_FIELDS.length).default([]),
  submitText: z.string().trim().max(40).default(''),
  buttonColor: hex.optional(),
  afterOrderMessage: z.string().trim().max(300).default(''),
});

/**
 * The bar that follows the customer up the page with what is in the cart.
 *
 * A Single Product store has no cart, so this is not a setting it can hold —
 * the tab is absent there, not greyed out, and `cartBarApplies` is what both
 * the screen and the server ask.
 */
export const storeCartBarSchema = z.object({
  enabled: z.boolean().default(true),
  label: z.string().trim().max(40).default(''),
});

/**
 * The home page's COVER IMAGE, and nothing about its sections.
 *
 * The order of the sections briefly lived here as `sectionOrder`. It belongs
 * to the page builder (/store/design), where the sections themselves are —
 * an order stored apart from the things it orders is a second owner, and the
 * two drift the first time a section is added anywhere but here.
 */
export const storeHomeSchema = z.object({
  /** Same-origin path only, like the landing theme's page image. */
  coverImage: z.string().regex(/^(|\/[A-Za-z0-9/_.\-]*)$/).max(300).default(''),
});

// ─────────────────────────────────────────────────────
// The whole thing
// ─────────────────────────────────────────────────────

/**
 * A store's theme: the landing theme, plus the shop-only parts.
 *
 * `.partial()` on the additions, not on the base: a store stored before
 * this existed is a valid landing theme and nothing more, and must keep
 * working exactly as it did.
 */
export const storeThemeSchema = landingThemeSchema.extend({
  fonts: storeFontsSchema.optional(),
  colors: storeColorsSchema.optional(),
  header: storeHeaderSchema.optional(),
  footer: storeFooterSchema.optional(),
  product: storeProductSchema.optional(),
  checkout: storeCheckoutSchema.optional(),
  cartBar: storeCartBarSchema.optional(),
  home: storeHomeSchema.optional(),
  layout: storeLayoutSchema.optional(),
  /**
   * WHICH OF THE TEN SHOP TEMPLATES THIS SHOP IS WEARING.
   *
   * Recorded on install rather than guessed afterwards. The alternative
   * was to derive it — match the accent and the arrangement back to a
   * template — and that is wrong twice: two templates may share an accent,
   * and a seller who changes a colour is still wearing the template they
   * chose. «القالب المثبّت معلّم بأعلى الشاشة» has to be true after
   * customisation, which only a recorded answer can be.
   *
   * Optional, and nothing reads it but the gallery: a shop that was
   * painted by hand has never worn one, and that is not a missing value,
   * it is the answer.
   */
  template: z.string().trim().min(1).max(40).optional(),
  /**
   * WHICH FAMILY THIS SHOP WEARS — «عيادة» · «عطّار» · «ترند» · «علامة».
   *
   * Optional, and read THROUGH `familyOf` below, which falls back to the
   * family of the template the shop installed. So a shop that has chosen
   * a voice has chosen a family without being asked a second question,
   * and a shop that wants the family's shape with its own colours can
   * say so in this one field.
   *
   * No migration: this column has always been JSON, and a key that is not
   * there reads as «the one my template belongs to».
   */
  family: z.enum(FAMILY_IDS).optional(),
  /**
   * «تغليف خفي» — THE OWNER'S §٩, AND A SETTING RATHER THAN A SENTENCE.
   *
   * «سطر إعداد بيشغّله المالك، مش ثابت. إذا مطفي ما بيطلع لا بالشريط
   * العلوي ولا بـ(ليش تطلب عنّا)». Printed unconditionally it would be a
   * promise the shop has not made — discreet packaging is something a
   * seller does or does not do, and a template must not claim it for
   * them. Default off, which is the honest default for a claim.
   */
  discreetPacking: z.boolean().optional(),
});

/**
 * The base is stated as `LandingTheme`, not inferred.
 *
 * `fontValueSchema` is a refined `z.string()`, so zod infers `font: string`
 * and the narrow `FontValue` — which every font helper takes — would be
 * lost the moment a theme came from a parse. The runtime check is the
 * refinement; this keeps the compiler's half of the same fact.
 */
export type StoreTheme = LandingTheme &
  Omit<z.infer<typeof storeThemeSchema>, keyof LandingTheme>;

/** A parsed theme, with the font fields carrying the type their rule proves. */
const asStoreTheme = (value: z.infer<typeof storeThemeSchema>): StoreTheme => value as StoreTheme;

export const DEFAULT_STORE_THEME: StoreTheme = {
  ...DEFAULT_THEME,
  fonts: {},
  colors: {},
  header: storeHeaderSchema.parse({}),
  footer: storeFooterSchema.parse({}),
  product: storeProductSchema.parse({}),
  checkout: storeCheckoutSchema.parse({}),
  cartBar: storeCartBarSchema.parse({}),
  home: storeHomeSchema.parse({}),
  layout: {},
};

/**
 * The stored JSON, or the house theme.
 *
 * A stored value that fails the schema falls back FIELD BY FIELD rather
 * than whole: a shop that saved a header height this code no longer accepts
 * should lose that height, not its colour and its fonts with it.
 */
export function parseStoreTheme(raw: string | null | undefined): StoreTheme {
  if (!raw) return DEFAULT_STORE_THEME;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_STORE_THEME;
  }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_STORE_THEME;

  parsed = migrateLegacyColors(parsed as Record<string, unknown>);

  const whole = storeThemeSchema.safeParse({ ...DEFAULT_THEME, ...(parsed as object) });
  if (whole.success) return { ...DEFAULT_STORE_THEME, ...asStoreTheme(whole.data) };

  // Piece by piece, keeping whatever still parses.
  const row = parsed as Record<string, unknown>;
  const base = landingThemeSchema.safeParse({ ...DEFAULT_THEME, ...row });
  const out: StoreTheme = {
    ...DEFAULT_STORE_THEME,
    ...(base.success ? (base.data as unknown as LandingTheme) : {}),
  };
  const parts = {
    fonts: storeFontsSchema, colors: storeColorsSchema, header: storeHeaderSchema,
    footer: storeFooterSchema, product: storeProductSchema, checkout: storeCheckoutSchema,
    cartBar: storeCartBarSchema, home: storeHomeSchema, layout: storeLayoutSchema,
  } as const;
  for (const [key, schema] of Object.entries(parts)) {
    const got = schema.safeParse(row[key] ?? {});
    if (got.success) (out as unknown as Record<string, unknown>)[key] = got.data;
  }
  return out;
}

// ─────────────────────────────────────────────────────
// Reading it
// ─────────────────────────────────────────────────────

/** Whether the bottom cart bar is a setting this store can even hold. */
export function cartBarApplies(storeType: string | null | undefined): boolean {
  return storeType !== 'SINGLE_PRODUCT';
}

/**
 * WHO DRAWS THE SHOP'S CHROME — ASKED ONCE, ANSWERED ONCE.
 *
 * A landing page can be served in three situations, and only one of them
 * wants the page to put a header and a footer around itself:
 *
 *   `/lp/<slug>` — an advert of its own. It keeps its own clothes; a
 *   header full of links is a way out of an advert.
 *
 *   A Single Product store's FRONT. Such a store's address renders this
 *   page, and it used to render it bare: no logo, no shop name, no menus.
 *   Everything the seller set under «القوالب» never appeared, on the only
 *   page that store has. So it wears the shop's chrome — unless the
 *   seller turned `header.onFrontPage` off, which is their switch.
 *
 *   INSIDE the shop, at `/s/<store>/p/<handle>`. Here the page is a panel
 *   of a screen that **has already drawn the shell** — with the «كل
 *   المنتجات» back link in it, which only that route knows. A page that
 *   added a second one gave an open store's product page two headers, two
 *   footers and the shell stylesheet twice.
 *
 * `inStore` AND NOT THE THEME FLAG for that last one. The flag is the
 * seller's answer to «how should my front page look», and it defaulted to
 * yes — so the in-store case inherited a yes to a question nobody had
 * asked about it, and the only way to get one header was for the seller
 * to disfigure their front page. Whether a shell is already on the screen
 * is the caller's fact, not a setting.
 */
export function wearsShopChrome(opts: {
  /** Served as a store's front page (as opposed to `/lp/<slug>`). */
  asFront: boolean;
  /** Served inside a shop screen that has already drawn the shell. */
  inStore: boolean;
  /** The store is known by a public slug — without one there is no shop to wear. */
  hasSlug: boolean;
  theme: StoreTheme;
}): boolean {
  if (opts.inStore) return false;
  if (!opts.asFront || !opts.hasSlug) return false;
  return opts.theme.header?.onFrontPage !== false;
}

/** The checkout fields this shop shows, in order, with nothing lost or doubled. */
export function checkoutOrder(theme: StoreTheme): CheckoutField[] {
  const wanted = theme.checkout?.fieldOrder ?? [];
  const seen = new Set<CheckoutField>();
  const ordered: CheckoutField[] = [];
  for (const f of wanted) {
    if (!seen.has(f)) { seen.add(f); ordered.push(f); }
  }
  // A field the stored order forgot is appended rather than dropped: the
  // address must not disappear because an older row listed five fields.
  for (const f of CHECKOUT_FIELDS) if (!seen.has(f)) ordered.push(f);
  return ordered;
}

/** Which checkout fields are required — the four that always are, plus the shop's. */
export function requiredCheckoutFields(theme: StoreTheme): CheckoutField[] {
  const chosen = new Set<CheckoutField>(theme.checkout?.required ?? []);
  for (const f of MANDATORY_CHECKOUT_FIELDS) chosen.add(f);
  return CHECKOUT_FIELDS.filter((f) => chosen.has(f));
}

/**
 * WHAT A LANDING PAGE'S ORDER FORM TAKES FROM ITS STORE'S «الدفع».
 *
 * «مش مربوط بصفحة الهبوط». The tab saved five settings and the shop's cart
 * checkout read three of them; every landing page drew its own fields, its
 * own button and its own thank-you line, so a seller who set the tab saw it
 * change nothing on the pages that sell.
 *
 * Read from the store's LIVE theme — the one a visitor's page is painted
 * from. Never the page's own theme, which is a look and holds no checkout,
 * and never the draft, which nobody has published.
 *
 * PLAIN DATA, DECIDED HERE. The form is a client component: importing this
 * module into it would put zod on every landing page. So the answers are
 * worked out on the server and handed over; the form imports their type.
 *
 *   · `fields` and `required` — the same two questions the cart checkout
 *     asks, through the same two functions above.
 *   · `submitText` and `thanksMessage` — trimmed, '' when the seller wrote
 *     none. `thanksMessage` is the store's `afterOrderMessage` under another
 *     name, because in the form `afterOrderMessage()` is already the
 *     WhatsApp text and one name for two things is how they get swapped.
 *   · `buttonColor` — #rrggbb, or null for «مثل اللون الأساسي». With it,
 *     `buttonVars`: the three variables the confirm button paints itself
 *     from, derived by the palette that derives the page's own — so the ink
 *     on a yellow button is measured, not assumed to be white.
 */
export interface PageCheckout {
  fields: CheckoutField[];
  required: CheckoutField[];
  submitText: string;
  buttonColor: string | null;
  buttonVars: Record<string, string> | null;
  thanksMessage: string;
}

/** The three the confirm button reads. The header band and the offer cards keep the page's own. */
const BUTTON_VARS = ['--store-accent', '--store-accent-text', '--store-accent-dark'] as const;

export function checkoutForPage(theme: StoreTheme): PageCheckout {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const colour = text(theme.checkout?.buttonColor);
  const buttonColor = hex.safeParse(colour).success ? colour : null;
  const vars = buttonColor ? paletteVars(paletteFor({ ...DEFAULT_THEME, accent: buttonColor })) : null;
  return {
    fields: checkoutOrder(theme),
    required: requiredCheckoutFields(theme),
    submitText: text(theme.checkout?.submitText),
    buttonColor,
    buttonVars: vars ? Object.fromEntries(BUTTON_VARS.map((name) => [name, vars[name]])) : null,
    thanksMessage: text(theme.checkout?.afterOrderMessage),
  };
}

/** The fields a page may depart from its store on. */
const LANDING_THEME_KEYS = Object.keys(landingThemeSchema.shape) as (keyof LandingTheme)[];

/**
 * A page's theme: its store's, unless that page overrides it.
 *
 * The store is the template; an override is one page departing from it, and
 * the editor says so out loud. The merge is FIELD BY FIELD: a page that
 * saved one value this code no longer accepts — a mood renamed, a colour
 * written another way — keeps the rest of what it chose. Refusing the whole
 * override would repaint a live page over one stale field, which is exactly
 * the kind of quiet change nobody would connect to a deploy.
 *
 * A key the theme does not have is dropped rather than carried through: an
 * override is a theme, not a bag of whatever a row happens to hold.
 */
export function themeForPage(
  storeTheme: StoreTheme,
  pageOverride: Partial<LandingTheme> | null | undefined
): LandingTheme {
  if (!pageOverride) return storeTheme;
  let out: LandingTheme = storeTheme;
  for (const key of LANDING_THEME_KEYS) {
    const value = (pageOverride as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const candidate = { ...out, [key]: value };
    if (landingThemeSchema.safeParse(candidate).success) out = candidate as LandingTheme;
  }
  return out;
}

/** The face used for headings / menus, falling back to the body face. */
/**
 * THE VARIANT A SHOPPER ACTUALLY GETS, FOR ONE SLOT.
 *
 * Retirement is resolved HERE and not at the seven call sites. A stored
 * value that nobody builds any more must never reach a `data-` attribute
 * with no rule behind it — and leaving that to each renderer is how the
 * thirteen dead variants happened in the first place: every one of them
 * was somebody's forgotten call site.
 *
 * The seller still sees the truth: `retiredNoteAr` reads the RAW stored
 * value on the theme screen and names both halves. Quiet here, loud
 * there, which is the right way round — the shopper needs a page that
 * works, the seller needs to know their template is holding something old.
 */
export function layoutOf<K extends keyof typeof DEFAULT_LAYOUT>(
  theme: StoreTheme,
  slot: K
): (typeof DEFAULT_LAYOUT)[K] {
  const stored =
    (theme.layout?.[slot] as (typeof DEFAULT_LAYOUT)[K] | undefined) ??
    /*
     * ── THE FAMILY ANSWERS BEFORE THE HOUSE DEFAULT, AND ONLY IF ASKED ──
     *
     * A shop that has NAMED a family has said «dress me as this», so the
     * family's own variant is what an unset slot means — that is the
     * whole of what a family is in the engine.
     *
     * A shop that has not named one keeps `DEFAULT_LAYOUT`, exactly as
     * before. Reading the default family here instead would have
     * repainted every shop that never chose anything — the header, the
     * first screen and the card all at once, on live shops, as a side
     * effect of adding a word to a type. «A store wearing one keeps its
     * look until the owner changes it» cuts both ways.
     */
    (theme.family ? familyLayoutOf(theme.family, slot) : undefined) ??
    DEFAULT_LAYOUT[slot];
  return effectiveVariant(slot, stored) as (typeof DEFAULT_LAYOUT)[K];
}

/** One slot of one family's look, typed as the slot's own union. */
function familyLayoutOf<K extends keyof typeof DEFAULT_LAYOUT>(
  family: FamilyId,
  slot: K
): (typeof DEFAULT_LAYOUT)[K] | undefined {
  const look = familyById(family);
  if (!look) return undefined;
  return (look.layout as Record<string, string>)[slot] as (typeof DEFAULT_LAYOUT)[K] | undefined;
}

/**
 * WHICH FAMILY THIS SHOP WEARS — asked in one place.
 *
 * In order: what the shop named, then the family of the template it
 * installed, then the default. The middle step is what makes the gallery
 * a family picker without a second question: a seller choosing «نبض»
 * has chosen «ترند», and nobody has to tell them that.
 */
export function familyOf(theme: StoreTheme): FamilyId {
  return theme.family ?? familyOfSkin(theme.template) ?? DEFAULT_FAMILY;
}

/** What the theme has stored, retirement and all — for the seller's own screen. */
export function storedLayoutOf<K extends keyof typeof DEFAULT_LAYOUT>(
  theme: StoreTheme,
  slot: K
): (typeof DEFAULT_LAYOUT)[K] {
  return (theme.layout?.[slot] as (typeof DEFAULT_LAYOUT)[K] | undefined) ?? DEFAULT_LAYOUT[slot];
}

export function headingFont(theme: StoreTheme): FontValue {
  return (theme.fonts?.heading as FontValue | undefined) ?? theme.font;
}
export function menuFont(theme: StoreTheme): FontValue {
  return (theme.fonts?.menu as FontValue | undefined) ?? theme.font;
}

/**
 * Every variable a shop's pages paint themselves with.
 *
 * The derived palette first — so a colour the seller never named is the one
 * the accent implies — then the named ones on top. Nothing here is a hex
 * literal in a component: a component reads var(--store-…), and this is the
 * one place the values are decided.
 */
export function storeThemeVars(theme: StoreTheme): Record<string, string> {
  const palette: Palette = paletteFor(theme);
  const vars: Record<string, string> = {
    ...paletteVars(palette),
    // The six the derived palette does not write. A price is read, not
    // decorated — it is the page's own ink, and the price it replaced is
    // the muted one — and a discount badge is the brand's colour rather
    // than the red that means a failure.
    '--store-price': palette.text,
    '--store-price-compare': palette.muted,
    '--store-offer-badge': palette.accent,
    '--store-success': STATE_COLORS.success,
    '--store-warning': STATE_COLORS.warning,
    '--store-danger': STATE_COLORS.danger,
    '--store-header-h': `${theme.header?.height ?? 72}px`,
    '--store-header-bg': theme.header?.background ?? palette.cardBg,
  };
  // Every colour a shop can name, written over the derived one. Driven by
  // COLOR_VAR rather than by a line each, because a field with no line is
  // a colour picker that changes nothing — which is exactly what four of
  // these were, for as long as they existed.
  for (const field of Object.keys(COLOR_VAR) as (keyof typeof COLOR_VAR)[]) {
    const value = theme.colors?.[field];
    if (value) vars[COLOR_VAR[field]] = value;
  }
  return vars;
}


/**
 * EVERY ROLE'S COLOUR, AS THE SHOP WILL ACTUALLY PAINT IT.
 *
 * The contrast rule is written in ROLES («النص على البطاقة»), the editor's
 * pickers are written in FIELDS (`textPrimary`, `surface1`), and most
 * fields are unset most of the time because the palette derives them from
 * the accent. Checking a pair therefore cannot read the theme's own
 * `colors` — half of them are empty, and the colour the shopper sees is
 * the derived one.
 *
 * So it reads what `storeThemeVars` resolved: the same map the page is
 * painted from, built by the same function, with the seller's named
 * colours already written over the derived ones. One resolver, so the
 * editor's verdict and the shop's appearance cannot disagree.
 */
const ROLE_VAR: Readonly<Record<string, string>> = Object.freeze({
  surface0: COLOR_VAR.background,
  surface1: COLOR_VAR.surface1,
  surface2: COLOR_VAR.surface2,
  textPrimary: COLOR_VAR.textPrimary,
  textSecondary: COLOR_VAR.textSecondary,
  border: COLOR_VAR.border,
  // The accent has no field of its own: it IS the theme's accent, and the
  // picker above the grid is the control for it.
  accent: '--store-accent',
  accentContrast: COLOR_VAR.accentContrast,
  price: COLOR_VAR.price,
  priceCompare: COLOR_VAR.priceCompare,
  offerBadge: COLOR_VAR.offerBadge,
  success: COLOR_VAR.success,
  warning: COLOR_VAR.warning,
  danger: COLOR_VAR.danger,
});

export function themeRoleColors(theme: StoreTheme): Record<string, string> {
  const vars = storeThemeVars(theme);
  const out: Record<string, string> = {};
  for (const [role, name] of Object.entries(ROLE_VAR)) {
    const value = vars[name];
    if (value) out[role] = value;
  }
  return out;
}
