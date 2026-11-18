/**
 * ═══════════════════════════════════════════════════════════════════════
 * DECORATION, AND THE THREE PLACES IT IS ALLOWED.
 *
 * Twelve themes, and nine of them are MOODS — neon, gold, parchment,
 * a sky with no moon. A mood that is nothing but thirty-four hexes is a
 * recoloured spreadsheet, so each theme may put an ambient touch on the
 * screen. And then the rule that matters:
 *
 *   ⚠️ NEVER WHERE THE DATA IS.
 *
 * Not behind a table, not behind a form, not behind an order, a figure of
 * money or a stock count. A glow under a column of numbers is a glow
 * somebody has to read through, every row, all day — and the person
 * reading it is deciding whether to ship something. The brand earns
 * attention at the door; inside, the numbers do.
 *
 * So there are exactly three places, and they are the three where nothing
 * is being measured or decided:
 *
 *   • `door`    — sign in, pick a country, pick a store, the splash.
 *   • `empty`   — a list with nothing in it yet.
 *   • `sidebar` — the header above the menu, where the wordmark sits.
 *
 * `a-theme-is-not-a-mood-swing.test.ts` sweeps every screen that renders
 * orders, money or stock and fails if one of them draws any of this.
 *
 * ── AND IT COSTS THE STYLESHEET NOTHING ──
 *
 * `decorCss` is written into the document by `SystemFrame`, beside the one
 * palette that person chose — the same reason, the same place. Somebody
 * who turned decoration off downloads none of it, and the first-load
 * stylesheet that reaches everybody does not grow by a byte. See
 * `SHEET_THEMES` in system-themes.ts.
 * ═══════════════════════════════════════════════════════════════════════
 */
import { AUTO_DARK, AUTO_LIGHT, AUTO_THEME, type SystemTheme } from './system-themes';

/**
 * OFF · LIGHT · FULL — and `light` is the default.
 *
 * Not `full`: the default has to be the setting somebody who never opens
 * settings would have chosen, and that is a touch rather than a show.
 * Not `off` either — eight of these themes would then be a palette with a
 * name.
 */
export const DECOR_LEVELS = ['off', 'light', 'full'] as const;
export type DecorLevel = (typeof DECOR_LEVELS)[number];
export const DEFAULT_DECOR: DecorLevel = 'light';

/** The three places, and nowhere else. */
export const DECOR_PLACES = ['door', 'empty', 'sidebar'] as const;
export type DecorPlace = (typeof DECOR_PLACES)[number];

/** The class a decoration layer carries, so one sweep can find all of them. */
export const DECOR_CLASS = 'zk-decor';

/** Only a level this build knows — a stored typo must not blank a screen. */
export function sanitizeDecor(raw: unknown): DecorLevel {
  return (DECOR_LEVELS as readonly unknown[]).includes(raw) ? (raw as DecorLevel) : DEFAULT_DECOR;
}

/**
 * The cookie, read on the server so the attribute is in the HTML the
 * browser parses — no script, no flash, and no migration for a setting
 * that belongs to a browser rather than to an account.
 */
export const DECOR_COOKIE = 'zk-decor';

/**
 * THE THEMES THAT WEAR NOTHING — added 18/11/2026 with «نظيف» (`clean`, R1).
 *
 * A theme's ornament is mood, and «نظيف» is the one palette whose whole point is the absence of it: white cards,
 * a dark menu, one colour. So it has no mask, no wash, no photograph and no file under `public/brand/decor/`;
 * `decorCss` answers an empty string for it at every level, exactly as it does for «off», and the three layers
 * (`ThemeDecor`) stay inert. The list is CLOSED: a theme joins it only by being added here on purpose, and
 * `a-clean-palette.test.tsx` fails if another one does.
 */
export const UNDECORATED: readonly string[] = ['clean'];

/**
 * The ambient CSS for one theme at one level.
 *
 * Built ENTIRELY from that theme's own tokens: `--sys-primary` and
 * `--sys-primary-soft` at low alpha over `--sys-background`. A decoration
 * with a hex of its own is a twelfth palette nobody measured, and
 * `system-themes.test.ts` would not be looking at it.
 *
 * ── WHAT EACH LEVEL ACTUALLY IS ──
 *
 * `light` is STATIC: two soft radial washes. Nothing moves, so there is
 * nothing for reduced motion to switch off and nothing for a hidden tab to
 * waste a frame on. That is the point of making it the default.
 *
 * `full` adds one slow drift on top — 24 seconds, a few pixels, a glow
 * rather than a thing. It is:
 *   • killed outright by `prefers-reduced-motion: reduce`, not slowed;
 *   • paused while the tab is hidden, via `[data-decor-hidden]`, because
 *     an animation in a background tab is a phone's battery for nobody.
 */
export function decorCss(theme: SystemTheme, level: DecorLevel, chosenKey?: string): string {
  if (level === 'off') return '';
  // `auto` resolves to a dark/light pair that DOES wear its ornaments, so only a chosen undecorated theme is silent.
  if (UNDECORATED.includes(theme.key) && chosenKey !== AUTO_THEME) return '';
  /*
   * ── «تلقائي» WEARS TWO ORNAMENTS, FOR THE SAME REASON IT HAS TWO PALETTES ──
   *
   * `themeByKey` resolves `auto` to the dark theme, because a function
   * that must return one theme has to pick one. The palette does not
   * work that way — `auto` carries both and lets the device choose — and
   * an ornament pinned to the dark one would put a radar sweep over a
   * white screen at noon. So the raw key is passed in, and when it is
   * `auto` both masks are written with the light one behind a media
   * query, exactly as the palette does it.
   */
  const art =
    chosenKey === AUTO_THEME
      ? ornament(AUTO_DARK) +
        `@media (prefers-color-scheme: light){${ornament(AUTO_LIGHT)}}`
      : ornament(theme.key);
  const wash =
    `.${DECOR_CLASS}{position:absolute;inset:0;pointer-events:none;z-index:0;` +
    `background:` +
    `radial-gradient(120% 85% at 85% 0%,var(--sys-primary-soft) 0%,transparent 55%),` +
    `radial-gradient(100% 70% at 10% 100%,var(--sys-primary-soft) 0%,transparent 50%)}` +
    // The sidebar header is a short strip, so the wash comes from one side
    // only; two washes in 56 pixels read as a smudge.
    `.${DECOR_CLASS}-sidebar{background:radial-gradient(140% 160% at 100% 0%,var(--sys-primary-soft) 0%,transparent 70%)}` +
    art;
  if (level === 'light') return wash;
  /*
   * ── A COMPOSED THEME TURNS ITS ROSETTE; IT DOES NOT DRIFT ──
   *
   * The drift moves the whole layer by up to 2% — a glow that wanders, which
   * is fine for a wash and wrong for a corner and a roofline that are
   * anchored to the edges of the screen: they would show a seam of
   * background along one side for half of every cycle. So the layer stays
   * put and only the rosette moves, once round in seven minutes — slow
   * enough that nobody sees it turn and everybody sees that it did.
   *
   * Door only. An empty list's box is wider than it is tall, and a mask
   * cannot be drawn outside the box it belongs to, so a rosette turning
   * inside one would be clipped differently every frame.
   *
   * The same two guards as the drift, for the same two reasons: reduced
   * motion removes it outright, and a hidden tab pauses it.
   */
  if (PHOTOGRAPHIC[theme.key] && chosenKey !== AUTO_THEME) {
    /*
     * ── A PHOTOGRAPH DOES NOT DRIFT; THE DOOR ZOOMS ──
     *
     * The drift below moves the whole layer by up to 2%: a glow that wanders,
     * which shows a seam of page along one edge for half of every cycle. Fine
     * for a wash, wrong for a picture. So the door scales — 6% over seventy
     * seconds, from its centre, a transform that cannot uncover an edge — and
     * the other two places stand still.
     *
     * Same two guards as every animation here: reduced motion removes it
     * outright, and a hidden tab pauses it.
     */
    return (
      wash +
      `@keyframes zk-decor-zoom{to{transform:scale(1.06)}}` +
      `.${DECOR_CLASS}-door.${DECOR_CLASS}-full{animation:zk-decor-zoom 70s ease-in-out infinite alternate;will-change:transform}` +
      `[data-decor-hidden] .${DECOR_CLASS}-door.${DECOR_CLASS}-full{animation-play-state:paused}` +
      `@media (prefers-reduced-motion: reduce){.${DECOR_CLASS}-door.${DECOR_CLASS}-full{animation:none}}`
    );
  }
  if (COMPOSED[theme.key] && chosenKey !== AUTO_THEME) {
    return (
      wash +
      `@keyframes zk-decor-turn{to{transform:rotate(1turn)}}` +
      `.${DECOR_CLASS}-door.${DECOR_CLASS}-full::before{animation:zk-decor-turn 420s linear infinite}` +
      `[data-decor-hidden] .${DECOR_CLASS}-door.${DECOR_CLASS}-full::before{animation-play-state:paused}` +
      `@media (prefers-reduced-motion: reduce){.${DECOR_CLASS}-door.${DECOR_CLASS}-full::before{animation:none}}`
    );
  }
  return (
    wash +
    `@keyframes zk-decor-drift{from{transform:translate3d(0,0,0)}to{transform:translate3d(-2%,1.5%,0)}}` +
    `.${DECOR_CLASS}-full{animation:zk-decor-drift 24s ease-in-out infinite alternate;will-change:transform}` +
    `[data-decor-hidden] .${DECOR_CLASS}-full{animation-play-state:paused}` +
    `@media (prefers-reduced-motion: reduce){.${DECOR_CLASS}-full{animation:none}}`
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AND THE ORNAMENT EACH THEME WEARS — SHAPE ONLY, NEVER COLOUR.
 *
 * Eleven drawings live in `public/brand/decor/<key>.webp`, one per theme:
 * a radar sweep, a girih star, an orbit, a laurel, a compass. They are
 * **masks** — one channel of coverage, no colour at all — and the colour
 * is painted through them from `--sys-primary`.
 *
 * That is not a size trick, though it is also that (440 KB for all eleven
 * instead of 1.6 MB, and one of them reaches one person). It is the rule
 * three paragraphs up, kept: «a decoration with a hex of its own is a
 * twelfth palette nobody measured». A full-colour picture carries its own
 * greens and golds that no palette test ever looks at, and it would stay
 * that colour when the theme's primary changed. A mask cannot drift,
 * because it has nothing to drift with.
 *
 * ── AND THE MIDDLE OF EVERY ONE OF THEM IS EMPTY ──
 *
 * Each mask fades to nothing across the middle fifth of the frame, so
 * every ornament is a FRAME rather than a picture. The three places all
 * put their content in the centre — the sign-in card, the empty state's
 * sentence, the sidebar's wordmark — so the hole is exactly where the
 * reading happens. It is cut into the art, not asked for in CSS, because
 * the one thing a background must never do is sit between a person and a
 * number.
 *
 * ── AND HOW LOUD EACH ONE IS, IS MEASURED ──
 *
 * Not chosen. Each mask was weighed by how much LIGHT it moves against
 * its own theme's background — the same quantity a contrast ratio is
 * built from — and given the opacity that lands all eleven on one target.
 * That is why these numbers are not round: `epic`'s gold on charcoal is
 * the biggest brightness gap in the set and lands at 0.36, while `cyber`'s
 * hairline on black cannot reach the target at all and is left whole.
 *
 * Measured, so the louder art is quieter by arithmetic rather than by
 * somebody squinting at it once — and so a replacement drawing cannot
 * quietly arrive at the wrong volume: re-run the measurement and this
 * table changes with it.
 */
const DECOR_INK: Record<string, number> = {
  ops: 0.397,
  day: 0.031,
  calm: 0.15,
  cyber: 1,
  space: 1,
  sea: 0.19,
  city90: 0.192,
  epic: 0.144,
  lux: 0.24,
  /*
   * «ليل» — weighed with the yardstick above, not picked. Its own drawing
   * (`layl.webp`: the khatam — two squares turned 45° — on a lattice, with
   * the middle 42% of the frame cut away so the hole is where the reading
   * happens) covers 9.85% of the frame in alpha; its teal on deep navy is a
   * 0.377 luminance gap; and the opacity that lands it on the MEDIAN of the
   * eight masks above that are not left whole (ink × coverage × gap =
   * 0.01506) is 0.406. A replacement drawing re-runs the same sum.
   */
  layl: 0.406,
};

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A THEME THAT WEARS THREE DRAWINGS, NOT ONE.
 *
 * The owner, 21/10: «الشكل خرافي مستوحى من الإسلامي حتى الرسوميات». One
 * mask behind a sign-in card is a pattern; the two Islamic themes are
 * meant to be a PLACE — a rosette to stand in front of, a corner of vine
 * and strapwork at each top corner, and a city's roofline along the
 * bottom. Each is its own drawing (`<key>.rosette.webp`, `.corner.webp`,
 * `.skyline.webp`), all masks, all painted from `--sys-primary`, so the
 * rule above holds for every one of them: no colour of their own.
 *
 * ── WHERE EACH GOES, AND WHY NOT ANYWHERE ELSE ──
 *
 *   door     rosette centred, a corner in each top corner, the skyline on
 *            the bottom edge. The corners and the skyline sit at the
 *            VIEWPORT'S edges, where nothing is ever drawn, so they work
 *            at any width — a frame around the card would have needed the
 *            card to be one size.
 *   empty    the rosette alone, fitted to the box. A list with nothing in
 *            it is the other place that is not measuring anything.
 *   sidebar  one corner, at the end of the header away from the wordmark.
 *
 * Never behind a figure. `a-theme-is-not-a-mood-swing.test.ts` sweeps the
 * screens for that and is not touched.
 *
 * ── THE LEFT CORNER IS THE RIGHT ONE, TURNED ──
 *
 * One drawing, mirrored by `transform: scaleX(-1)` on the layer that
 * carries it. A second file of the same drawing would be 68 KB of the same
 * bytes, for a person who only ever sees one of them at a time.
 *
 * ── AND THE NUMBERS BELOW ARE CHOSEN, NOT MEASURED ──
 *
 * The eleven single masks were weighed by the light they move and given the
 * opacity that put them on one target (above). That worked for one mask
 * behind a card and it did not survive a browser: a proof sheet of 260px
 * tiles measured a kinder screen than the real door, and the first build
 * put a radar through the wordmark. These three are set by eye, in a
 * browser, at 1920, 1280 and 390 pixels wide, over the real card size.
 * The corners and the skyline are quieter than they look and the rosette
 * quieter still, because the rosette is the one that sits where text is.
 *
 * The CSS below does exactly one thing differently from a single mask: it
 * hides the circuit-wave banner the door draws under everything
 * (`.zk-door-banner`), because a door that brings its own picture should
 * not be wearing another one beneath it.
 * ═══════════════════════════════════════════════════════════════════════
 */
export interface Composition {
  rosette: number;
  corner: number;
  skyline: number;
}
export const COMPOSED: Record<string, Composition> = {
  // Night: navy and gold. Dense strapwork, a grand skyline — louder, because
  // gold on navy is a gentler pair than it looks and carries the weight.
  'islamic-epic': { rosette: 0.15, corner: 0.28, skyline: 0.17 },
  // Day: ivory and green. Single lines and palms — quieter, because dark on
  // pale paper is the loudest pairing in the set.
  'islamic-calm': { rosette: 0.14, corner: 0.24, skyline: 0.16 },
};

/** The three drawings of a composed theme, by the name the file carries. */
export const PIECES = ['rosette', 'corner', 'skyline'] as const;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE THEMES THAT WEAR PHOTOGRAPHS — THE ONE PLACE «MASKS ONLY» IS BROKEN,
 * AND WHAT HOLDS IN ITS PLACE.
 *
 * The rule above — shape only, never colour — was written for a reason that
 * still stands: «a decoration with a hex of its own is a twelfth palette
 * nobody measured», because a full-colour picture carries greens and golds
 * that no palette test ever looks at. The owner, 21/10, asked for exactly
 * that anyway, for one theme: «ثيم جي تي ايه بصور حقيقية» — and decided where
 * («بالأماكن التلاتة بس»). So `neon-coast` wears three real photographs of a
 * beachfront at the blue hour.
 *
 * And on 23/10/2026 the owner approved opening the same list to a second
 * theme, «ليل» (`layl` — the theme a new member of staff opens on), so that
 * the real pictures made for it are actually seen: the courtyard gate at
 * night, the road to the kasbah, and the empty-list family. That approval is
 * the only reason the list has two names, and the claim that holds the list
 * names both on purpose. What the rule protected is protected the same way
 * for the two of them:
 *
 *   • THE LIST IS CLOSED. `PHOTOGRAPHIC` below has two keys, and
 *     a-photographic-theme-keeps-its-text-readable.test.ts fails if a third
 *     appears without somebody editing that claim on purpose.
 *   • THE THREE PLACES ARE THE SAME THREE. Nothing here is drawn by another
 *     component, and never behind a table, a form, an order, a figure of
 *     money or a stock count — the sweep in a-theme-is-not-a-mood-swing.test.ts
 *     still runs over every screen that draws any of this.
 *   • THE TEXT DOES NOT DEPEND ON THE PICTURE. A picture can be replaced by
 *     anybody, and the numbers beside it nudged by anybody reading them as
 *     taste, so — like the door's own banner — every number below is held by
 *     a test that composites PURE WHITE, the worst picture there could be,
 *     through the same numbers and asks whether the dimmest text still clears
 *     4.5:1. The picture is mood; the colour under the words is the page's.
 *
 * ── WHAT EACH PLACE DOES ──
 *
 *   door     the wide picture, or the portrait one on a phone (a browser asks
 *            for only the one that matches, so nobody downloads both), under a
 *            veil of the page's own colour. The door's text column becomes a
 *            panel of that colour at `panel` — and that panel, not the picture,
 *            is what every word of the sign-in page is read against. Without
 *            it the paragraph under the card lands on lit windows on a phone.
 *   empty    the same picture at `empty` opacity behind the empty list's
 *            sentence, faded to nothing at its edges by a mask.
 *   sidebar  the 5:1 strip across the header of the menu, under a veil that is
 *            heaviest where the wordmark is. In a right-to-left layout that is
 *            the right-hand side, and the strip was shot with its calm sea on
 *            the right for that reason.
 *
 * ── AND WHAT «ليل» DOES DIFFERENTLY, AND WHY ──
 *
 *   door     the same arrangement: the courtyard gate at night (the wide
 *            picture) or the road to the kasbah (the portrait one, made as a
 *            loading panel and standing here because a phone is a portrait
 *            door), under a veil and with a panel of the page's own colour
 *            under every word.
 *   empty    not one picture but one per FAMILY of screen — the bell on the
 *            confirmation queue, the tied parcel on preparation, the map on
 *            shipment tracking, the scales on matching and collection, the
 *            money office on the rest of the money, the crate on returns and
 *            stock, the warehouse on receiving and production, and the
 *            magnifier everywhere else. The family is read from the address
 *            by `emptyFamilyOf` below and written once, on the shell's main
 *            element, as `data-empty-family`. The layer that shows it is
 *            still the one EmptyState draws and nothing else: no fourth
 *            place, no picture element, no change to EmptyState.
 *            And the picture lies on a POOL of the page's own darkest colour,
 *            laid by the layer itself — because «ليل»'s palette leaves no
 *            room on its lightest surface: its primary on `surface` measures
 *            4.48:1 before any picture at all, so a picture laid straight onto
 *            that surface (white being the worst picture there could be)
 *            would take the action link under the bar at any strength. On the
 *            pool the words are read against `--sys-background`, which is what
 *            the claim composites the white picture over.
 *   sidebar  no strip was made for «ليل», so the header keeps the theme's own
 *            drawing — the corner of its octagram lattice, painted from
 *            `--sys-primary` at its measured `DECOR_INK`, exactly as a theme
 *            with a single mask draws it there.
 *
 * ── AND WHAT IT COSTS ──
 *
 * The stylesheet nothing, like every other ornament: written by `SystemFrame`
 * for the one theme rendered. Each picture is under 120 KB, a person is sent
 * one of the two door pictures, not both, and an empty list asks for the one
 * picture of its own family — a rule that matches no element downloads
 * nothing. At «full» the door zooms — very slowly, from its centre, so no edge
 * is ever uncovered — and the other two stand still: a layer that DRIFTS shows
 * a seam of page along one side, which is fine for a wash and wrong for a
 * photograph.
 *
 * `color-mix()` is how the veil is made from the theme's own tokens, so no
 * hex is written here. A browser too old to know it drops the whole
 * declaration, and what it then shows is the plain wash — a door with no
 * picture, never a picture with no veil.
 * ═══════════════════════════════════════════════════════════════════════
 */
export interface Photographs {
  /** The wide door picture, and the portrait one a phone is given instead. */
  door: string;
  doorTall: string;
  /**
   * The 5:1 strip across the header of the menu. Absent: the header keeps the theme's own mask
   * (`DECOR_INK`), drawn exactly as a theme with a single mask draws it there.
   */
  strip?: string;
  /** Page colour laid over the door's text column, 0–1. What every word of the sign-in page is read against. */
  panel: number;
  /** Page colour over the whole door picture at the top, the middle and the bottom — mood, not safety. */
  veil: readonly [number, number, number];
  /** How much of an empty list is picture: its opacity, or — over the pool — its share of it. */
  empty: number;
  /** Sidebar colour over the strip where the wordmark is, and where only the picture shows. Comes with `strip`, never alone. */
  header?: readonly [number, number];
  /**
   * An empty list's picture by the family of the screen it is on (`emptyFamilyOf`), on a pool of the
   * page's own background. Absent: an empty list wears the door picture straight onto its surface.
   */
  emptyArt?: Readonly<Record<EmptyFamily, string>>;
}

export const PHOTOGRAPHIC: Record<string, Photographs> = {
  'neon-coast': {
    door: 'neon-coast.door.webp',
    doorTall: 'neon-coast.door-tall.webp',
    strip: 'neon-coast.strip.webp',
    panel: 0.8,
    veil: [0.55, 0.2, 0.55],
    empty: 0.14,
    header: [0.82, 0.25],
  },
  /*
   * «ليل» — opened to pictures by the owner on 23/10/2026. Every file here was generated for this
   * theme from the single prompt list (D1, L1–L3, E1–E6) and checked, picture by picture, for a
   * five-pointed star, text and a watermark before it was wired: see public/brand/CREDITS.md.
   *
   * `panel` is the first step of 0.05 at which the primary (#36B5CC) clears 4.5:1 over a pure white
   * picture: neon-coast's 0.8 leaves it at 4.37, 0.85 gives 5.24 — room, not a hairline. `empty` is the
   * share of the pool the picture may have and still leave every word above 5:1 over a white one.
   */
  layl: {
    door: 'layl.door.webp',
    doorTall: 'layl.door-tall.webp',
    panel: 0.85,
    veil: [0.55, 0.25, 0.6],
    empty: 0.14,
    emptyArt: {
      'new-orders': 'layl.empty.new-orders.webp',
      preparation: 'layl.empty.preparation.webp',
      tracking: 'layl.empty.tracking.webp',
      matching: 'layl.empty.matching.webp',
      finance: 'layl.empty.finance.webp',
      inventory: 'layl.empty.inventory.webp',
      warehouse: 'layl.empty.warehouse.webp',
      search: 'layl.empty.search.webp',
    },
  },
};

/** Every file a photographic theme owns, by the name it carries on the disk. */
export function photographsOf(key: string): string[] {
  const p = PHOTOGRAPHIC[key];
  if (!p) return [];
  return [p.door, p.doorTall, ...(p.strip ? [p.strip] : []), ...(p.emptyArt ? Object.values(p.emptyArt) : [])];
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE FAMILY OF THE SCREEN AN EMPTY LIST IS ON.
 *
 * The empty-list pictures were made for particular screens — each prompt
 * says where it goes — and this table is those sentences, read as addresses.
 * Most specific first, because «/finance/matching» is also under «/finance».
 * Anything not named is «search»: the magnifier was made for «any search that
 * found nothing», which is what an unnamed empty list most often is.
 *
 * It decides a PICTURE and nothing else: no permission, no data, no route.
 * The shell writes the answer on its main element as `data-empty-family`,
 * whatever the theme, and only a theme with `emptyArt` has a rule that reads
 * it. Every prefix is held to a real route by the claim, so a renamed screen
 * cannot quietly fall back to the magnifier.
 * ═══════════════════════════════════════════════════════════════════════
 */
export const EMPTY_FAMILIES = [
  'new-orders',
  'preparation',
  'tracking',
  'matching',
  'finance',
  'inventory',
  'warehouse',
  'search',
] as const;
export type EmptyFamily = (typeof EMPTY_FAMILIES)[number];

/** The attribute the shell writes and the empty-list rules read. */
export const EMPTY_FAMILY_ATTR = 'data-empty-family';

export const EMPTY_FAMILY_OF_PATH: ReadonlyArray<readonly [string, EmptyFamily]> = [
  ['/confirmation', 'new-orders'], // E1 — «الطلبات الجديدة» لما ما في ولا طلب بستنى تأكيد
  ['/orders', 'new-orders'],
  ['/ops/preparation', 'preparation'], // E2 — «التجهيز» لما كل الطرود جاهزة
  ['/ops/returns', 'inventory'], // E3 — the empty crate, made for «المرتجعات» and filed under stock
  ['/ops/tracking', 'tracking'], // E4 — «متابعة الشحن» لما ما في طرد بالطريق
  ['/ops/batches', 'tracking'],
  ['/ops/shipments', 'tracking'],
  ['/finance/matching', 'matching'], // E5 — «المطابقة» و«التحصيل والكشوف»
  ['/finance/collection', 'matching'],
  ['/finance', 'finance'], // L3 — مكتب المال: the rest of the money
  ['/manufacturing', 'warehouse'],
  ['/inventory', 'inventory'],
  ['/products', 'inventory'],
];

/** The family of the screen at `pathname`; «search» for anything the table does not name. */
export function emptyFamilyOf(pathname: string | null | undefined): EmptyFamily {
  if (!pathname) return 'search';
  for (const [prefix, family] of EMPTY_FAMILY_OF_PATH) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return family;
  }
  return 'search';
}

/**
 * A theme's own mask, as a corner bled off the top edge of the header above the menu — so the strip
 * carries a hint of the ornament rather than a small complete copy of it. One string, used by a theme
 * with a single mask and by a photographic theme that has no strip, so the two cannot drift apart.
 */
const SIDEBAR_CORNER = 'no-repeat right -40px top -64px/200px';

function photographic(key: string, p: Photographs): string {
  const D = DECOR_CLASS;
  const url = (file: string) => `url(/brand/decor/${file})`;
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  // The theme's own colour, as much of it as is asked for: no hex of its own.
  const mix = (token: string, n: number) => `color-mix(in srgb,var(--sys-${token}) ${pct(n)},transparent)`;
  const door = (file: string) =>
    `background:linear-gradient(180deg,${mix('background', p.veil[0])} 0%,${mix('background', p.veil[1])} 45%,` +
    `${mix('background', p.veil[2])} 100%),${url(file)} center bottom/cover no-repeat`;
  const fade = 'radial-gradient(ellipse at center,black 38%,transparent 80%)';
  return (
    // The door brings its own picture; take the circuit wave out from under it.
    `.zk-door-banner{display:none}` +
    // ── the door: the wide picture, or the portrait one when the window is taller than it is wide ──
    `.${D}-door{${door(p.door)}}` +
    `@media (orientation:portrait){.${D}-door{${door(p.doorTall)}}}` +
    // The text column is a panel of the page's own colour — see the header above for why it is the panel
    // that carries the words, and the claims for what it guarantees.
    `.zk-door-column{background:${mix('background', p.panel)};-webkit-backdrop-filter:blur(10px);` +
    `backdrop-filter:blur(10px);border-radius:1.25rem;padding:1rem}` +
    (p.emptyArt ? emptyByFamily(p.emptyArt, p.empty, mix, url, fade) : emptyFromTheDoor(p, url, fade)) +
    (p.strip && p.header ? strip(p.strip, p.header, mix, url) : ownCorner(key))
  );
}

/** ── an empty list: the door picture, faint, faded out at its edges (`neon-coast`) ── */
function emptyFromTheDoor(p: Photographs, url: (f: string) => string, fade: string): string {
  const D = DECOR_CLASS;
  return (
    `.${D}-empty{background:${url(p.door)} center 72%/cover no-repeat;opacity:${p.empty};` +
    `-webkit-mask:${fade};mask:${fade}}` +
    `@media (orientation:portrait){.${D}-empty{background-image:${url(p.doorTall)}}}`
  );
}

/**
 * ── an empty list: its family's picture, on a pool of the page's own background (`layl`) ──
 *
 * One declaration carries the veil, the picture and the pool, so a browser without `color-mix()` drops
 * all three together and shows the plain wash. The magnifier is the rule every empty list starts from;
 * a family's rule replaces only the picture, and only that family's picture is ever downloaded.
 */
function emptyByFamily(
  art: Readonly<Record<EmptyFamily, string>>,
  share: number,
  mix: (token: string, n: number) => string,
  url: (f: string) => string,
  fade: string
): string {
  const D = DECOR_CLASS;
  const veil = mix('background', 1 - share);
  const layers = (file: string) => `linear-gradient(${veil},${veil}),${url(file)}`;
  return (
    `.${D}-empty{background:${layers(art.search)} center/cover no-repeat var(--sys-background);` +
    `-webkit-mask:${fade};mask:${fade}}` +
    EMPTY_FAMILIES.filter((f) => f !== 'search')
      .map((f) => `[${EMPTY_FAMILY_ATTR}=${f}] .${D}-empty{background-image:${layers(art[f])}}`)
      .join('')
  );
}

/** ── the header of the menu: heaviest veil on the right, where the wordmark is (`neon-coast`) ── */
function strip(
  file: string,
  header: readonly [number, number],
  mix: (token: string, n: number) => string,
  url: (f: string) => string
): string {
  return (
    `.${DECOR_CLASS}-sidebar{background:linear-gradient(to left,${mix('sidebar', header[0])} 0%,` +
    `${mix('sidebar', header[0])} 55%,${mix('sidebar', header[1])} 100%),${url(file)} right center/cover no-repeat}`
  );
}

/** ── the header of the menu, for a theme with no strip: its own mask's corner, at its measured ink (`layl`) ── */
function ownCorner(key: string): string {
  const ink = DECOR_INK[key];
  if (!ink) return '';
  const url = `url(/brand/decor/${key}.webp)`;
  return (
    `.${DECOR_CLASS}-sidebar::after{content:'';position:absolute;inset:0;` +
    `background-color:var(--sys-primary);opacity:${ink};` +
    `-webkit-mask:${url} ${SIDEBAR_CORNER};mask:${url} ${SIDEBAR_CORNER}}`
  );
}

function composed(key: string, c: Composition): string {
  const D = DECOR_CLASS;
  const url = (piece: string) => `url(/brand/decor/${key}.${piece}.webp)`;
  // `at` and `size` are the two halves of the mask shorthand, and the
  // shorthand is written in both spellings: Safari still wants the prefix.
  const paint = (piece: string, at: string, size: string, opacity: number) =>
    `background-color:var(--sys-primary);opacity:${opacity};` +
    `-webkit-mask:${url(piece)} no-repeat ${at}/${size};mask:${url(piece)} no-repeat ${at}/${size}`;
  const pseudo = `content:'';position:absolute;inset:0;`;
  const box = `position:absolute;inset:0;`;
  const CORNER = 'min(46vmin,420px) auto';
  return (
    // The door brings its own picture; take the circuit wave out from under it.
    `.zk-door-banner{display:none}` +
    // ── the door ──
    // The rosette is `::before`, so it is painted FIRST and the corners and
    // the skyline sit over it where they meet at the bottom.
    `.${D}-door::before{${pseudo}${paint('rosette', 'center', 'min(92vmin,1000px)', c.rosette)}}` +
    `.${D}-door::after{${pseudo}${paint('corner', 'right top', CORNER, c.corner)}}` +
    `.${D}-door .${D}-l{${box}${paint('corner', 'right top', CORNER, c.corner)};transform:scaleX(-1)}` +
    `.${D}-door .${D}-b{${box}${paint('skyline', 'center bottom', 'min(100%,1700px) auto', c.skyline)}}` +
    // ── an empty list: the rosette, fitted to the box, never cropped by it ──
    `.${D}-empty::after{${pseudo}${paint('rosette', 'center', 'contain', c.rosette)}}` +
    // ── the sidebar: one corner, at the end away from the wordmark ──
    `.${D}-sidebar::after{${pseudo}${paint('corner', 'right top', '170px auto', c.corner)};transform:scaleX(-1)}`
  );
}

/**
 * The mask layer for one theme, or nothing.
 *
 * `mask-image` with the `-webkit-` prefix beside it: Safari still wants
 * the prefixed property, and a theme losing its ornament is a smaller
 * failure than a solid primary-coloured square, which is what an ignored
 * mask leaves behind. Hence `background-color` only inside this rule.
 */
function ornament(key: string): string {
  if (PHOTOGRAPHIC[key]) return photographic(key, PHOTOGRAPHIC[key]);
  if (COMPOSED[key]) return composed(key, COMPOSED[key]);
  const ink = DECOR_INK[key];
  if (!ink) return '';
  const url = `url(/brand/decor/${key}.webp)`;
  return (
    `.${DECOR_CLASS}::after{content:'';position:absolute;inset:0;` +
    `background-color:var(--sys-primary);opacity:${ink};` +
    `-webkit-mask:${url} no-repeat center/contain;mask:${url} no-repeat center/contain}` +
    // ── THE DOOR'S IS BIG BECAUSE THE HOLE HAS TO CLEAR THE CARD ──
    //
    // The empty middle is a fixed fraction of the art, so the only way to
    // make it wider than the sign-in card is to make the whole ornament
    // wider. At 620px the hole was about 270 and the card is about 420, so
    // the drawing ran straight through the wordmark — which a browser
    // showed and the proof sheet did not. At 1020 the hole clears it.
    `.${DECOR_CLASS}-door::after{-webkit-mask-size:min(96vmin,1020px);mask-size:min(96vmin,1020px)}` +
    `.${DECOR_CLASS}-empty::after{-webkit-mask-size:320px;mask-size:320px}` +
    // A corner, bled off the top edge, so the strip above the menu carries
    // a hint of the ornament rather than a small complete copy of it.
    `.${DECOR_CLASS}-sidebar::after{-webkit-mask:${url} ${SIDEBAR_CORNER};mask:${url} ${SIDEBAR_CORNER}}`
  );
}

/** A year. A preference about a background does not expire with a session. */
const KEEP = 60 * 60 * 24 * 365;

/** What this browser last chose. Falls to the default rather than to nothing. */
export function readDecor(): DecorLevel {
  try {
    const m = new RegExp(`${DECOR_COOKIE}=([a-z]+)`).exec(document.cookie);
    return sanitizeDecor(m?.[1]);
  } catch {
    // A browser that refuses cookies gets the default, which is the level
    // that needs no explanation.
    return DEFAULT_DECOR;
  }
}

/**
 * Remember it — and then RELOAD, deliberately.
 *
 * The CSS for this is written into the document by the server, because
 * that is what keeps it out of the stylesheet everybody downloads. So the
 * new level arrives with the next HTML, and the honest way to apply it is
 * to ask for that HTML. The alternative — shipping all three levels and
 * switching a class — is the ten kilobytes this whole arrangement exists
 * to avoid, for a setting somebody changes about twice.
 */
export function setDecor(level: DecorLevel): void {
  try {
    document.cookie = `${DECOR_COOKIE}=${level}; path=/; max-age=${KEEP}; SameSite=Lax`;
  } catch {
    /* Remembering is a convenience; the reload below still applies it. */
  }
}
