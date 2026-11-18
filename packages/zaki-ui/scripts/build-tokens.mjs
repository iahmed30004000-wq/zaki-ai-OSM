/**
 * ONE SOURCE, TWO FILES.
 *
 * The brief asks for `tokens.css` and `tokens.json` with «the same names and
 * values». Two hand-written files with that promise are two files that will
 * disagree on a Tuesday, and nothing would notice until a colour in the
 * studio stopped matching the same colour in operations. So both are
 * GENERATED here, from one object, and a test re-runs this and fails if
 * either file on disk differs from what it produces.
 *
 * THE COLOURS ARE NOT TYPED IN. They are read out of the product's own
 * stylesheet, `src/app/(system)/system.css`, so «extraction, not redesign»
 * is enforced by the build rather than by my care. Change a palette there
 * and the package follows; type a colour here and the next reader cannot
 * tell which of the two is the shop's real one.
 *
 * Run: node packages/zaki-ui/scripts/build-tokens.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const REPO = resolve(PKG, '..', '..');
const SYSTEM_CSS = join(REPO, 'src', 'app', '(system)', 'system.css');
/** The product's palettes. The stylesheet mirrors two of them; this holds all. */
const SYSTEM_THEMES_TS = join(REPO, 'src', 'lib', 'system-themes.ts');

export const VERSION = '0.1.0';

/**
 * WHICH `--sys-` NAME BECOMES WHICH `--zk-` NAME.
 *
 * A rename and nothing else: every value is carried across untouched. The
 * categories are the brief's — surface, text, border, brand, state — and
 * the product's names are kept in `MAPPING.md` so a reader of either side
 * can find the other.
 *
 * `--sys-destructive` becomes `error` because the brief names that category
 * «خطأ». It is the same colour; operations calls it «destructive» because
 * there it also paints a delete button.
 */
export const RENAME = {
  // ── surface ──────────────────────────────────────────────────────────
  'background': 'color-surface-page',
  'card': 'color-surface-card',
  'surface': 'color-surface-sunken',
  'surface-strong': 'color-surface-raised',
  'sidebar': 'color-surface-sidebar',
  // ── text ─────────────────────────────────────────────────────────────
  'heading': 'color-text-heading',
  'foreground': 'color-text',
  'muted-foreground': 'color-text-muted',
  'muted': 'color-text-faint',
  /*
   * The product now STATES this value per palette (it used to be an alias
   * that resolved against the default theme's grey). It is named here so
   * it is carried rather than reported as unmapped — and then deliberately
   * replaced by a REFERENCE a few lines below, for the reason given there.
   */
  'border-input': 'color-border-input',
  'sidebar-foreground': 'color-text-sidebar',
  /*
   * 18/11/2026 (R4): the menu's own five, so a dark menu on a light page
   * never borrows a content colour. Carried like the rest — a rename only.
   */
  'sidebar-muted': 'color-text-sidebar-muted',
  'sidebar-heading': 'color-text-sidebar-heading',
  'sidebar-accent': 'color-text-sidebar-accent',
  'sidebar-border': 'color-border-sidebar',
  'sidebar-hover': 'color-surface-sidebar-hover',
  // ── border───────────────────────────────────────────────────────────
  'border': 'color-border',
  'border-strong': 'color-border-strong',
  'focus': 'color-focus',
  // ── brand ────────────────────────────────────────────────────────────
  'primary': 'color-brand',
  'primary-hover': 'color-brand-hover',
  'primary-soft': 'color-brand-soft',
  'primary-foreground': 'color-brand-on',
  // ── states ───────────────────────────────────────────────────────────
  'success': 'color-success',
  'success-soft': 'color-success-soft',
  'warning': 'color-warning',
  'warning-soft': 'color-warning-soft',
  'destructive': 'color-error',
  'destructive-soft': 'color-error-soft',
  'destructive-border': 'color-error-border',
  // ── charts ───────────────────────────────────────────────────────────
  'chart-1': 'color-chart-1',
  'chart-2': 'color-chart-2',
  'chart-3': 'color-chart-3',
  'chart-4': 'color-chart-4',
  'chart-5': 'color-chart-5',
  'chart-6': 'color-chart-6',
  // ── scrollbars ───────────────────────────────────────────────────────
  'scrollbar': 'color-scrollbar',
  'scrollbar-hover': 'color-scrollbar-hover',
  /*
   * These two were READ twice by `.sidebar-scroll` and DECLARED nowhere, so
   * the sidebar's thumb had no colour and the browser drew its own. They are
   * declared now, in all three palettes, as `var(--sys-scrollbar)` and its
   * hover — no new colour was introduced, which is what the sidebar looked
   * like it was always meant to do.
   */
  'sidebar-scrollbar': 'color-scrollbar-sidebar',
  'sidebar-scrollbar-hover': 'color-scrollbar-sidebar-hover',
  // ── elevation (theme-resolved: a shadow that reads on black is not the
  //     shadow that reads on white) ─────────────────────────────────────
  'shadow-raised': 'shadow-raised',
  'shadow-overlay': 'shadow-overlay',
};

/**
 * Declared outside every palette, in a plain `:root` — the same for all
 * themes, so it belongs to the scale rather than to a theme.
 */
export const GLOBAL_SYS = { 'mobile-nav-h': 'layout-mobile-nav-h' };

/** Which palette in the product becomes which selector in the package. */
export const THEMES = [
  /*
   * DARK IS BOTH THE DEFAULT AND A NAME YOU CAN ASK FOR.
   *
   * `:root` alone makes dark the thing you get when you say nothing, which
   * is right — but it leaves no way to say «dark» out loud. A page that has
   * switched to light and wants one dark panel, or a studio that stores the
   * person's choice as a word, needs the selector to exist. Both are
   * emitted, so `[data-theme="dark"]` on any element returns it to the
   * default palette from inside a light one.
   */
  { key: 'dark', from: 'ops', selector: ':root, [data-theme="dark"]', note: 'الافتراضيّة — وهي لوحة «العمليّات» الغامقة، وتُطلَب بالاسم أيضاً' },
  { key: 'light', from: 'day', selector: '[data-theme="light"]', note: 'لوحة «النهار»' },
  { key: 'calm', from: 'calm', selector: '[data-theme="calm"]', note: 'لوحة «الهادئة» — فاتحةٌ ثانيةٌ موجودةٌ في المنتج' },
];

/**
 * THE SPACING SCALE, DERIVED FROM WHAT THE PRODUCT ACTUALLY USES.
 *
 * There were no spacing tokens to extract: every screen writes Tailwind's
 * raw steps. So this was measured instead of invented — 4342 spacing
 * utilities across 244 dashboard files — and these nine steps are 98.1% of
 * them. The share of each is recorded so the next person can see the scale
 * was counted, not chosen.
 *
 * NAMED BY PIXELS, not by index. `--zk-space-8` is eight pixels. An index
 * scale would make `--zk-space-4` mean 8px, which is the kind of quiet trap
 * a second team reading this package has no way to catch.
 *
 * The tail — 36, 40, 48, 64, 80, 96, 112 — is 1.9% and is page layout, not
 * component spacing. It is left out of the component scale deliberately.
 */
export const SPACE = [
  { px: 0, uses: 25, share: 0.6 },
  { px: 2, uses: 234, share: 5.4 },
  { px: 4, uses: 607, share: 14.0 },
  { px: 6, uses: 531, share: 12.2 },
  { px: 8, uses: 1072, share: 24.7 },
  { px: 10, uses: 225, share: 5.2 },
  { px: 12, uses: 944, share: 21.7 },
  { px: 16, uses: 449, share: 10.3 },
  { px: 20, uses: 39, share: 0.9 },
  { px: 24, uses: 126, share: 2.9 },
  { px: 32, uses: 32, share: 0.7 },
];

/** 6 on a control, 10 on a card, 16 on a sheet, full on a chip. */
export const RADIUS = { control: '0.375rem', card: '0.625rem', sheet: '1rem', full: '9999px' };

/**
 * The type scale, exactly the product's: 12 · 13 · 14 · 16 · 20 · 24 · 32,
 * and NOTHING below 12 — «العربيّة عند تسعة بكسل ليست نصّاً صغيراً بل
 * لطخة»: the script carries meaning in the marks above and below the
 * letters, and at that size they merge into the line.
 */
export const TEXT = { 12: '0.75rem', 13: '0.8125rem', 14: '0.875rem', 16: '1rem', 20: '1.25rem', 24: '1.5rem', 32: '2rem' };

/** The four weights the product downloads, and no fifth. */
export const WEIGHT = { regular: '400', medium: '500', semibold: '600', bold: '700' };

/**
 * Line heights as the product sets them: 1.65 on Arabic body text, 1.7 in
 * tables (a column of Arabic needs more room than a paragraph), 1.6 under
 * the 13px note, 1.2 on the display figure.
 */
export const LEADING = { body: '1.65', table: '1.7', note: '1.6', display: '1.2' };

/**
 * THE LAYERING LADDER, READ OFF THE PRODUCT RATHER THAN NUMBERED AFRESH.
 *
 * Every one of these is a value some screen already uses, and the name is
 * what uses it: 40 is the mobile bar, 50 is a dialog, 60 is a toast (it has
 * to sit above the dialog that raised it), 65 is the idle lock, 70 is the
 * command palette and the lock's own top layer. Renumbering them «neatly»
 * would be a redesign of stacking order, and stacking order is the one
 * thing nobody notices until something disappears behind something else.
 */
export const LAYER = {
  'z-base': '10',
  'z-sticky': '20',
  'z-dock': '30',
  'z-nav': '40',
  'z-modal': '50',
  'z-toast': '60',
  'z-lock': '65',
  'z-palette': '70',
};

/**
 * THE SMALLEST THING A FINGER IS ASKED TO HIT — 44px, used 212 times in
 * this product as `min-h-11`, and it is not a preference: below it a
 * warehouse thumb misses, and every miss on a shipment screen is a wrong
 * parcel. Named so the studio cannot pick its own smaller number.
 */
export const TAP = { 'tap-min': '2.75rem' };

/**
 * THE FOCUS RING, as the product actually draws it: a 2px outline offset by
 * 2px, on `:focus-visible` only — the browser's own judgement of «this
 * person is using a keyboard». A ring on every mouse click reads as an
 * error, which is why the width is a token and the trigger is not.
 */
export const FOCUS = { 'focus-width': '2px', 'focus-offset': '2px' };

/**
 * A CONTROL IS ONE HEIGHT, AND IT IS STATED.
 *
 * The product writes `h-11 md:h-10` on every field — 44px under a finger,
 * 40px under a mouse — and the comment in `Input.tsx` says why it is stated
 * rather than left to padding: «padding alone made the height a by-product
 * of the font size, and a row of controls came out four heights».
 */
export const CONTROL = { 'control-h': '2.5rem' };

/**
 * THE FEW WIDTHS THAT ARE DECISIONS, NOT SPACING.
 *
 * A dialog's maximum width and a line's maximum measure are not steps on
 * the spacing scale — they are judgements about reading. Naming them keeps
 * them out of the components as bare numbers, which is the rule, and puts
 * them somewhere a second team can see and argue with.
 *
 * `--zk-measure` is in `ch` on purpose: a line's comfortable length is
 * counted in characters, and in `rem` it would change with the font.
 */
export const SIZE = { 'size-dialog': '32rem', 'size-toast': '24rem', 'measure': '60ch' };

/** One curve for every movement, and the one duration the product uses. */
export const MOTION = { 'ease-standard': 'cubic-bezier(0.2, 0, 0.1, 1)', 'duration-fast': '150ms', 'duration-base': '200ms' };

/**
 * The families. The package hosts the files itself — no Google Fonts, no
 * CDN — and the stack is the product's own, in its order.
 */
export const FONT = {
  arabic: "'IBM Plex Sans Arabic'",
  /*
   * `--zk-font-latin` IS GONE, and that was a choice between two honest
   * options: ship Public Sans, or stop naming it.
   *
   * Operations lists it between Plex and the system stack, and it is only
   * ever reached for a glyph Plex does not carry. Plex's Latin cut here
   * carries 225 codepoints — the whole of Latin-1 and the punctuation a
   * dashboard uses — so the fallback fires almost never, and shipping a
   * second family for it would add weight to the one thing the studio
   * cannot afford: a first load with the internet off.
   *
   * The difference against operations, stated rather than buried: for a
   * glyph neither Plex nor the system faces have, operations would try
   * Public Sans first and the package goes straight to Segoe UI. Naming a
   * family the package does not ship would be worse — the browser would
   * skip a name that resolves to nothing and land in the same place, while
   * the token claimed otherwise.
   */
  sans: "var(--zk-font-arabic), 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif",
};

// ── reading the product's palettes ───────────────────────────────────────
/**
 * A TOKEN WHOSE VALUE POINTS AT ANOTHER TOKEN MUST POINT AT OURS.
 *
 * `--sys-sidebar-scrollbar` is declared as `var(--sys-scrollbar)` in the
 * product — correct there, and poison here: the studio is a separate page
 * that has never heard of `--sys-` anything, so the reference resolves to
 * nothing and the scrollbar loses its colour again, this time silently and
 * only in the studio.
 *
 * Caught by the owner reading the output. The rewrite runs over every
 * value, not just the ones I know about today, and a test asserts the
 * string `--sys-` never appears in the generated CSS at all.
 */
function repoint(value, rename) {
  return value.replace(/var\(--sys-([a-z0-9-]+)\)/g, (whole, name) => {
    const to = rename[name];
    if (!to) throw new Error(`a token points at --sys-${name}, which has no --zk- name`);
    return `var(--zk-${to})`;
  });
}

/**
 * ── WHERE A PALETTE IS READ FROM, NOW THAT THE SHEET HOLDS ONLY TWO ──
 *
 * `system.css` used to carry every palette, and this read the selector's
 * block out of it. It now carries the DEFAULT and «تلقائي» only: the other
 * nine are written into the document by `SystemFrame`, because eleven
 * palettes in the first-load stylesheet is ten kilobytes of colours nine
 * people in ten never see (see `SHEET_THEMES` in
 * src/lib/system-themes.ts).
 *
 * So the palettes are read from the REGISTRY — the TypeScript objects that
 * the stylesheet itself mirrors, and that `system-themes.test.ts` holds
 * the two in step with. «Extraction, not redesign» is unchanged; what
 * changed is which copy of the product's colours is the one copy.
 *
 * Parsed rather than imported because this is a plain .mjs run by node
 * with no TypeScript in the loop, and a build step that needs a compiler
 * is a build step that breaks on a Tuesday. The shape it reads is an
 * object literal of `name: '#hex'` lines, and it fails loudly on a
 * palette it cannot find rather than emitting a theme with no colours.
 */
function registryPalettes(ts) {
  const out = {};
  const re = /\n {2}\{\n {4}key: '([a-z0-9-]+)',[\s\S]*?\n {4}vars: \{\n([\s\S]*?)\n {4}\},/g;
  for (const m of ts.matchAll(re)) {
    const vars = {};
    for (const v of m[2].matchAll(/^\s*'?([a-z0-9-]+)'?:\s*'([^']+)',/gm)) vars[v[1]] = v[2].trim();
    out[m[1]] = vars;
  }
  return out;
}

function paletteOf(palettes, key) {
  const found = palettes[key];
  if (!found || Object.keys(found).length < 20) {
    throw new Error(`palette not found in system-themes.ts: ${key}`);
  }
  return found;
}

/** The palettes are parsed with a pattern that cuts at `\n`; a CRLF checkout (Windows, `core.autocrlf=true`) would find no palette at all. */
const lf = (text) => text.replace(/\r\n/g, '\n');

export function build() {
  const css = readFileSync(SYSTEM_CSS, 'utf8');
  const palettes = registryPalettes(lf(readFileSync(SYSTEM_THEMES_TS, 'utf8')));
  const unmapped = new Set();

  const themes = {};
  for (const t of THEMES) {
    const raw = paletteOf(palettes, t.from);
    const named = {};
    for (const [key, value] of Object.entries(raw)) {
      const to = RENAME[key];
      if (!to) {
        unmapped.add(key);
        continue;
      }
      named[to] = repoint(value, RENAME);
    }
    /**
     * THE ONE BORDER THAT IS NOT DECORATION.
     *
     * WCAG 1.4.11 asks 3:1 of the boundary of a control a person has to
     * find and click. Measured against the surface an input sits on,
     * `color-border-strong` is 2.74:1 in the dark palette, **1.87:1 in the
     * light one and 1.89:1 in the calm one** — and the plain `color-border`
     * is 1.25:1. None of them passes, and the light palettes are not close.
     *
     * `color-text-faint` is the only colour already in the product that
     * clears 3:1 in all three (5.16 / 5.05 / 5.13), so this points AT it
     * rather than introducing a fourth grey. A reference, not a copy: one
     * colour, one place to change it.
     *
     * The decorative borders keep their values on purpose. 1.4.11 is about
     * the boundary of a CONTROL, and a rule between two paragraphs that
     * met 3:1 would draw the eye to the furniture instead of the content.
     *
     * ⚠️ The product states its own `--sys-border-input` now, and this
     * still overwrites it — on purpose. Inside one `[data-theme]` block a
     * reference resolves against that block's own `text-faint`, so the
     * package keeps one colour with one place to change it, which a copied
     * hex would not.
     */
    named['color-border-input'] = 'var(--zk-color-text-faint)';

    themes[t.key] = { selector: t.selector, from: t.from, note: t.note, tokens: named };
  }

  const scale = {};
  for (const s of SPACE) scale[`space-${s.px}`] = s.px === 0 ? '0' : `${s.px / 16}rem`;
  for (const [k, v] of Object.entries(RADIUS)) scale[`radius-${k}`] = v;
  for (const [k, v] of Object.entries(TEXT)) scale[`text-${k}`] = v;
  for (const [k, v] of Object.entries(WEIGHT)) scale[`weight-${k}`] = v;
  for (const [k, v] of Object.entries(LEADING)) scale[`leading-${k}`] = v;
  for (const [k, v] of Object.entries(MOTION)) scale[k] = v;
  for (const [k, v] of Object.entries(LAYER)) scale[k] = v;
  for (const [k, v] of Object.entries(TAP)) scale[k] = v;
  for (const [k, v] of Object.entries(FOCUS)) scale[k] = v;
  for (const [k, v] of Object.entries(CONTROL)) scale[k] = v;
  for (const [k, v] of Object.entries(SIZE)) scale[k] = v;
  for (const [k, v] of Object.entries(FONT)) scale[`font-${k}`] = v;

  // The globals the product declares in a bare `:root`, carried across with
  // their values read from the same file as everything else.
  for (const [from, to] of Object.entries(GLOBAL_SYS)) {
    const m = css.match(new RegExp(`--sys-${from}\s*:\s*([^;]+);`));
    if (!m) throw new Error(`global token not found in system.css: --sys-${from}`);
    scale[to] = m[1].trim();
  }

  return { themes, scale, unmapped: [...unmapped].sort() };
}

function cssFor({ themes, scale }) {
  const line = (name, value) => `  --zk-${name}: ${value};`;
  const parts = [];
  parts.push(`/*
 * zaki-ui tokens — v${VERSION}
 *
 * GENERATED by packages/zaki-ui/scripts/build-tokens.mjs. Do not edit: the
 * colours are read out of src/app/(system)/system.css, so this file and the
 * product cannot drift apart, and tokens.json is written from the same
 * object so the two outputs cannot disagree either.
 *
 * Dark is the default because the product's default palette is dark and 18
 * of its 19 accounts run it.
 */`);

  parts.push('');
  parts.push('/* ── the scale: one set, every theme ──────────────────────────────── */');
  parts.push(':root {');
  for (const [k, v] of Object.entries(scale)) parts.push(line(k, v));
  parts.push('}');

  for (const t of THEMES) {
    const theme = themes[t.key];
    parts.push('');
    parts.push(`/* ── ${t.key}: ${t.note} ─────────────────────────────── */`);
    parts.push(`${theme.selector} {`);
    for (const [k, v] of Object.entries(theme.tokens)) parts.push(line(k, v));
    parts.push('}');
  }

  parts.push('');
  parts.push(`/*
 * RTL AND THE DIGITS.
 *
 * The product sets both on the document, not in a component: «الأرقام
 * الغربيّة» is enforced by a repo guard, not by CSS, so a package that only
 * ships colours cannot promise it. What CSS CAN promise is that the digits
 * line up in a column, and that is what this does — it is the single most
 * useful typographic decision in a product where every screen is numbers.
 */`);
  /*
   * THE PAGE HAS A BACKGROUND, OR THE BROWSER'S WHITE SHOWS THROUGH.
   *
   * Found by LOOKING at the rendered demo rather than by reading the CSS:
   * the shell painted correctly and the page behind it was transparent, so
   * white appeared below the shell and on every overscroll — in the DARK
   * theme. A dark product with a white edge is the same defect as a white
   * dialog, seen from the other side.
   *
   * Scoped to `.zk` and not to `[dir="rtl"]`: that selector matches the
   * operations app's own <html>, and a stylesheet this package ships must
   * not be able to repaint a product that merely imports its tokens.
   */
  parts.push('.zk {');
  parts.push('  background-color: var(--zk-color-surface-page);');
  parts.push('  color: var(--zk-color-text);');
  parts.push('  min-block-size: 100%;');
  parts.push('}');
  parts.push('');
  parts.push('[dir="rtl"], .zk {');
  parts.push('  font-family: var(--zk-font-sans);');
  parts.push('  line-height: var(--zk-leading-body);');
  parts.push('  font-variant-numeric: tabular-nums;');
  parts.push('  font-feature-settings: "tnum" 1;');
  parts.push('}');
  parts.push('');
  parts.push('/* Arabic joins its letters: spacing them apart severs the joins. */');
  parts.push('[lang="ar"] {');
  parts.push('  letter-spacing: 0;');
  parts.push('  text-transform: none;');
  parts.push('}');
  parts.push('');
  return parts.join('\n');
}

function jsonFor(built) {
  return (
    JSON.stringify(
      {
        name: 'zaki-ui',
        version: VERSION,
        prefix: '--zk-',
        generatedFrom: 'src/app/(system)/system.css',
        note: 'مولَّدٌ من build-tokens.mjs — نفسُ الأسماء والقيم في tokens.css',
        defaultTheme: 'dark',
        scale: built.scale,
        spacingDerivedFrom: {
          method: 'عُدَّت من الاستعمال الفعليّ في 244 ملفَّ لوحةٍ — 4342 استعمالاً',
          steps: SPACE,
          coverage: '98.1% من الاستعمالات؛ والباقي (36..112px) تخطيطُ صفحةٍ لا مسافةَ مكوّن',
        },
        themes: Object.fromEntries(
          Object.entries(built.themes).map(([k, v]) => [k, { selector: v.selector, from: v.from, note: v.note, tokens: v.tokens }])
        ),
        /**
         * TWO NAMES THAT DO NOT EXPLAIN THEMSELVES, written down so the
         * studio does not guess. Both are real distinctions in the product,
         * and both are easy to use backwards.
         */
        contrast: {
          note: 'مقيسٌ مقابل السطح الذي يجلس عليه الحقل (color-surface-card). القاعدة WCAG 1.4.11 لحدود عناصر التحكّم: 3:1.',
          'color-border-input': { dark: 5.16, light: 5.05, calm: 5.13, passes: true, isA: 'var(--zk-color-text-faint)' },
          'color-border-strong': { dark: 2.74, light: 1.87, calm: 1.89, passes: false, why: 'فاصلٌ زخرفيٌّ لا حدَّ عنصرِ تحكّم — والقاعدة لا تسري عليه' },
          'color-border': { dark: 1.48, light: 1.25, calm: 1.29, passes: false, why: 'الحدُّ الافتراضيّ، زخرفيٌّ كذلك' },
        },
        glossary: {
          'color-text-muted': 'النصُّ الثانويُّ المقروء: سطرُ شرحٍ تحت عنوان، عمودٌ ثانٍ في جدول. يُقرأ بلا جهد.',
          'color-text-faint': 'أخفتُ منه، ولغيرِ المقروء: نائبُ الحقل، الفاصلةُ بين جزأين، «—» مكانَ قيمةٍ غائبة. لا تضع فيه معلومةً يحتاجها القارئ.',
          'color-border': 'الحدُّ الافتراضيُّ لكلّ شيء: بطاقة، حقل، صفّ.',
          'color-border-strong': 'حدٌّ يُقصد أن يُرى: فاصلٌ بين قسمين، أو إطارُ شيءٍ مُنتقى. استعمالُه في كلّ مكانٍ يُلغي معناه. وهو زخرفيٌّ — لا تحدّ به حقلاً.',
          'color-border-input': 'حدُّ الحقل والزرّ وكلِّ ما يُنقَر. الوحيدُ الملزَم بتباين 3:1، ويشير إلى text-faint لأنّه اللونُ الوحيدُ الموجود الذي يجتازه في اللوحات الثلاث.',
          'color-surface-sunken': 'سطحٌ أغمقُ من البطاقة داخلها: رأسُ جدول، شريطُ تلميح.',
          'color-surface-raised': 'سطحٌ أفتحُ منها: صفٌّ مُحدَّد، أو زرٌّ ثانويٌّ عليه.',
        },
        notPresentInTheProduct: [
          'color-info — لا لونَ «معلومة» في المنتج. لم يُخترَع.',
          'مسافاتٌ مرمَّزة — لم تكن موجودة؛ اشتُقّت من العدّ أعلاه.',
        ],
      },
      null,
      2
    ) + '\n'
  );
}

const built = build();
mkdirSync(PKG, { recursive: true });
writeFileSync(join(PKG, 'tokens.css'), cssFor(built), 'utf8');
writeFileSync(join(PKG, 'tokens.json'), jsonFor(built), 'utf8');

const count = Object.keys(built.themes.dark.tokens).length;
console.log(`tokens.css + tokens.json written — ${count} theme tokens × ${THEMES.length} themes, ${Object.keys(built.scale).length} scale tokens`);
if (built.unmapped.length) console.log('UNMAPPED --sys- names (not carried over):', built.unmapped.join(', '));
