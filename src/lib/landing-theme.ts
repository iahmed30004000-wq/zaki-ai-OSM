/**
 * LANDING THEME — one colour in, a harmonious page out.
 *
 * Giving a seller a CSS box does not give them a beautiful page; it gives
 * them thirty decisions, and the page ends up with a red button, a blue
 * link and a green badge because each was chosen on a different day.
 *
 * So the page is themed, not painted. The seller picks ONE accent colour
 * and a mood, and every other shade is derived from it: the button, the
 * price, the badge tint, the border, the strip at the top. They cannot
 * clash, because they are the same colour at different lightnesses.
 *
 * The derivation runs in OKLCH — a space where equal lightness steps look
 * equal to the eye — so a pale tint of a yellow and a pale tint of a navy
 * read as equally pale, which is exactly what plain HSL gets wrong.
 */

import { z } from 'zod';

export interface LandingTheme {
  /** The one colour the seller picks, as #rrggbb. */
  accent: string;
  /** How the page carries itself. */
  mood: ThemeMood;
  /**
   * The page's typeface: a key from the library, or `u:<slug>` for one the
   * seller uploaded to this store. Not `ThemeFont` alone — the field has
   * held both since stores could bring their own, and a type that says
   * otherwise pushes a cast into every caller.
   */
  font: FontValue;
  /** Rounded or square corners throughout. */
  corners: 'soft' | 'sharp';
  /**
   * A photograph behind the WHOLE page, not behind one block.
   *
   * A block background paints one band; a seller who wants a textured page
   * had to set the same image on every block and keep them in step. This is
   * the page's own backdrop, set once.
   *
   * '' means the mood's flat paper, which stays the default — a photograph
   * behind body text is a good way to make a page unreadable, so it is a
   * choice and never an accident.
   */
  pageImage: string;
  /**
   * How much of the page colour is laid over that photograph, 0…0.95.
   *
   * Without it the text sits straight on the picture and the page cannot be
   * read. The veil is the page's own paper colour, so a warm page veils warm
   * and a clean page veils white — it never turns the photo grey.
   */
  pageVeil: number;
  /**
   * WHICH OF THE SIXTY-FOUR DESIGNS THE PAGE WAS STARTED FROM, if any —
   * an id from `landing-designs/catalog.ts`, checked there at creation.
   * The look itself is drawn from the catalogue; this only names it, so a
   * reader that does not know the id draws the page as if it were absent.
   */
  design?: string;
}

export type ThemeMood = 'clean' | 'warm' | 'bold' | 'calm';
export type ThemeFont =
  | 'tajawal' | 'cairo' | 'almarai' | 'ibm' | 'rubik' | 'noto'
  | 'changa' | 'reem' | 'lalezar' | 'marhey' | 'amiri' | 'aref'
  | 'readex' | 'alexandria' | 'vazir' | 'mada' | 'messiri' | 'baloo'
  | 'naskh' | 'scheherazade' | 'kawkab'
  | 'thmanyah' | 'thmanyahtext' | 'thmanyahdisplay' | 'system';

export const DEFAULT_THEME: LandingTheme = {
  accent: '#b8256e',
  mood: 'clean',
  font: 'tajawal',
  corners: 'soft',
  pageImage: '',
  pageVeil: 0.82,
};



export const MOODS: { key: ThemeMood; label: string; hint: string }[] = [
  { key: 'clean', label: 'نظيف', hint: 'أبيض واسع، حدود خفيفة' },
  { key: 'warm', label: 'دافئ', hint: 'خلفية كريمية، ظلال ناعمة' },
  { key: 'bold', label: 'جريء', hint: 'تباين عالٍ، عناوين ثقيلة' },
  { key: 'calm', label: 'هادئ', hint: 'رمادي فاتح، ألوان مخفّفة' },
];

/**
 * THE font library. There is exactly one, and it lives here.
 *
 * There were two: four families for the page theme and twelve for a single
 * block, so the same screen offered a seller a font in one panel that the
 * other panel could not see. Two lists of the same thing are two lists to
 * keep in step, and they were already out of step.
 *
 * Each row carries everything anybody needs about that face: the Arabic
 * name the seller reads, the CSS stack, and the Google family string with
 * its weights — `google` absent means the face is already on the device and
 * needs no stylesheet.
 *
 * The order is the order a seller should meet them: the three workhorses
 * that suit any page, then the display faces for a headline, then the two
 * serifs, then the system default.
 */
export const FONTS: {
  key: ThemeFont;
  label: string;
  stack: string;
  /** Google's family string with weights. Absent when we serve it ourselves. */
  google?: string;
  /** True when the files live in /public/fonts and BLOCK_CSS declares them. */
  local?: boolean;
  /**
   * True for a face this machine may use and this site may not serve.
   *
   * Its files sit outside git and are handed over by /api/dev-fonts, which
   * answers 404 in a production build. The picker says so plainly, because
   * a font that works while you design and vanishes when you publish is a
   * trap unless the seller was told.
   */
  devOnly?: boolean;
  /**
   * True for a face a STORE TEMPLATE may be built on: it covers Arabic, its
   * licence is an open one, and this site may serve it.
   *
   * A template ships to every shop that installs it, so its typeface is not
   * a choice one seller makes for one page — it is a face we publish. That
   * rules out `devOnly` faces, which vanish in a production build, and it
   * rules out faces with no Arabic coverage, which would silently fall
   * through to the system stack on the only script the shop is written in.
   *
   * The flag lives HERE and not in a second list beside the templates: a
   * face added to this library is either usable by a template or it is not,
   * and a list kept elsewhere is a list that falls behind. See
   * `TEMPLATE_FONTS` in store-skin.ts, which is this filter and nothing
   * more.
   */
  openArabic?: boolean;
  note: string;
}[] = [
  { key: 'tajawal', label: 'طجوال', stack: "'Tajawal', system-ui, sans-serif", google: 'Tajawal:wght@200;400;500;700;800', openArabic: true, note: 'واضح ومحايد' },
  { key: 'cairo', label: 'القاهرة', stack: "'Cairo', system-ui, sans-serif", google: 'Cairo:wght@400;600;700;800', openArabic: true, note: 'الأكثر استخداماً' },
  { key: 'almarai', label: 'المراعي', stack: "'Almarai', system-ui, sans-serif", google: 'Almarai:wght@400;700;800', openArabic: true, note: 'هادئ ومقروء' },
  { key: 'ibm', label: 'IBM بلكس', stack: "'IBM Plex Sans Arabic', system-ui, sans-serif", google: 'IBM+Plex+Sans+Arabic:wght@400;500;600;700', openArabic: true, note: 'رسمي ومرتّب' },
  { key: 'rubik', label: 'روبيك', stack: "'Rubik', system-ui, sans-serif", google: 'Rubik:wght@400;500;700;800', note: 'ودود وعصري' },
  { key: 'noto', label: 'نوتو كوفي', stack: "'Noto Kufi Arabic', system-ui, sans-serif", google: 'Noto+Kufi+Arabic:wght@400;600;700;800', openArabic: true, note: 'كوفي متّزن' },
  { key: 'changa', label: 'تشانغا', stack: "'Changa', system-ui, sans-serif", google: 'Changa:wght@400;600;700;800', openArabic: true, note: 'عريض للعناوين' },
  { key: 'reem', label: 'ريم كوفي', stack: "'Reem Kufi', system-ui, sans-serif", google: 'Reem+Kufi:wght@400;600;700', openArabic: true, note: 'هندسي أنيق' },
  { key: 'lalezar', label: 'لاله زار', stack: "'Lalezar', system-ui, cursive", google: 'Lalezar', openArabic: true, note: 'صارخ وإعلاني' },
  { key: 'marhey', label: 'مرحي', stack: "'Marhey', system-ui, cursive", google: 'Marhey:wght@400;600;700', openArabic: true, note: 'مرِح وشبابي' },
  { key: 'amiri', label: 'أميري', stack: "'Amiri', Georgia, serif", google: 'Amiri:wght@400;700', openArabic: true, note: 'نسخ كلاسيكي' },
  { key: 'aref', label: 'عارف رقعة', stack: "'Aref Ruqaa', Georgia, serif", google: 'Aref+Ruqaa:wght@400;700', openArabic: true, note: 'رقعة فخم' },
  { key: 'readex', label: 'ريدكس برو', stack: "'Readex Pro', system-ui, sans-serif", google: 'Readex+Pro:wght@300;400;500;600;700', openArabic: true, note: 'حديث ومتوازن' },
  { key: 'alexandria', label: 'الإسكندرية', stack: "'Alexandria', system-ui, sans-serif", google: 'Alexandria:wght@400;500;700;800', openArabic: true, note: 'هندسي نظيف' },
  { key: 'vazir', label: 'وزير', stack: "'Vazirmatn', system-ui, sans-serif", google: 'Vazirmatn:wght@400;500;700;800', openArabic: true, note: 'مقروء على الشاشة' },
  { key: 'mada', label: 'مدى', stack: "'Mada', system-ui, sans-serif", google: 'Mada:wght@400;500;700;900', openArabic: true, note: 'بسيط وواسع' },
  { key: 'messiri', label: 'المصيري', stack: "'El Messiri', system-ui, sans-serif", google: 'El+Messiri:wght@400;500;600;700', openArabic: true, note: 'أنيق للعناوين' },
  { key: 'baloo', label: 'بالو بهيجان', stack: "'Baloo Bhaijaan 2', system-ui, cursive", google: 'Baloo+Bhaijaan+2:wght@400;600;700;800', openArabic: true, note: 'سميك ومستدير' },
  { key: 'naskh', label: 'نوتو نسخ', stack: "'Noto Naskh Arabic', Georgia, serif", google: 'Noto+Naskh+Arabic:wght@400;500;600;700', openArabic: true, note: 'نسخ للقراءة الطويلة' },
  { key: 'scheherazade', label: 'شهرزاد', stack: "'Scheherazade New', Georgia, serif", google: 'Scheherazade+New:wght@400;700', openArabic: true, note: 'نسخ تقليدي فخم' },
  // Served from /public/fonts rather than Google, because it is not on
  // Google — and because its licence (SIL OFL 1.1, stated inside the font
  // file itself) is one of the few that actually permits us to serve it.
  // public/fonts/kawkab-OFL.txt carries the notice the licence requires.
  { key: 'kawkab', label: 'كوكب', stack: "'Kawkab Mono', ui-monospace, monospace", local: true, openArabic: true, note: 'ثابت العرض — تقني' },
  // ── Licensed for this machine, never published. See /api/dev-fonts. ──
  { key: 'thmanyah', label: 'ثمانية', stack: "'thmanyah sans', system-ui, sans-serif", devOnly: true, note: 'محلي — للفحص فقط' },
  { key: 'thmanyahtext', label: 'ثمانية نص', stack: "'thmanyah serif text', Georgia, serif", devOnly: true, note: 'محلي — للفحص فقط' },
  { key: 'thmanyahdisplay', label: 'ثمانية عريض', stack: "'thmanyah serif display', Georgia, serif", devOnly: true, note: 'محلي — للفحص فقط' },
  { key: 'system', label: 'خط النظام', stack: "system-ui, 'Segoe UI', Tahoma, sans-serif", note: 'الأسرع تحميلاً' },
];

/** Every key in the library, for the places that need the list as data. */
export const FONT_KEYS = FONTS.map((f) => f.key);

/**
 * A font a page may ask for: one of the library's keys, or an uploaded
 * family referenced as `u:<slug>`.
 *
 * A hardcoded enum was kept in three places and had already fallen behind
 * in two of them — eight faces the picker offered could not be saved on a
 * block at all, because the block's enum had never been updated. One
 * predicate, and adding a face to FONTS is the whole change.
 *
 * An uploaded family resolves through a CSS variable the page declares
 * rather than through a lookup here, so this stays a pure function with no
 * idea which store it is rendering — and a font the seller deleted falls
 * back to the system stack instead of throwing.
 */
/** A face this store uploaded, referenced by its slug. */
export type UploadedFontRef = `u:${string}`;

/** Anything the `font` field may hold. */
export type FontValue = ThemeFont | UploadedFontRef;

export const UPLOADED_FONT_RE = /^u:[a-z0-9-]{1,40}$/;

export function isFontValue(v: string): boolean {
  return v === '' || FONT_KEYS.includes(v as ThemeFont) || UPLOADED_FONT_RE.test(v);
}

/** The CSS stack for any font value, built-in or uploaded. */
export function stackFor(value: string | undefined | null): string {
  if (!value) return '';
  const known = FONTS.find((f) => f.key === value);
  if (known) return known.stack;
  if (UPLOADED_FONT_RE.test(value)) return `var(--store-uf-${value.slice(2)}, system-ui, sans-serif)`;
  return '';
}

/** Zod's view of the same rule. */
export const fontValueSchema = z
  .string()
  .max(45)
  .refine(isFontValue, { message: 'خط غير معروف' });

/** What a stored theme is allowed to be. Anything else falls back whole. */
export const landingThemeSchema = z.object({
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  mood: z.enum(['clean', 'warm', 'bold', 'calm']),
  font: fontValueSchema,
  corners: z.enum(['soft', 'sharp']),
  // Same-origin paths only. An absolute URL here is a way to make the
  // seller's page fetch from somewhere we do not control, and to leak every
  // visitor to it; uploads go through the page's own media route.
  pageImage: z.string().regex(/^(|\/[A-Za-z0-9/_.\-]*)$/).max(300).default(''),
  pageVeil: z.number().min(0).max(0.95).default(0.82),
  // A catalogue id. Optional and plain: the editor's save must carry it
  // through, and a stale id is harmless — the catalogue is what draws it.
  design: z.string().regex(/^[a-z0-9-]{1,60}$/).optional(),
});


// ─────────────────────────────────────────────────────
// Colour, honestly
// ─────────────────────────────────────────────────────

/** #rrggbb → linear-light sRGB triple, or null when it is not a colour. */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const srgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  // Undo the sRGB transfer function; blending gamma-encoded values is what
  // makes naive tints look muddy.
  return srgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
}

function toHex([r, g, b]: [number, number, number]): string {
  const enc = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    const s = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(s * 255).toString(16).padStart(2, '0');
  };
  return `#${enc(r)}${enc(g)}${enc(b)}`;
}

/** Linear sRGB → OKLab. */
function toOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → linear sRGB. */
function fromOklab([L, a, b]: [number, number, number]): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/**
 * The same colour at a chosen lightness, keeping its hue.
 * `chroma` scales how saturated the result stays: a tint wants less.
 */
function atLightness(hex: string, lightness: number, chroma = 1): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const [, a, b] = toOklab(rgb);
  return toHex(fromOklab([lightness, a * chroma, b * chroma]));
}

/** Perceived lightness of a colour, 0–1. */
export function lightnessOf(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0.5;
  return toOklab(rgb)[0];
}

/** WCAG relative luminance, from the already-linear sRGB triple. */
function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Success, warning and danger — the three colours no palette derives.
 *
 * They are not the shop's to choose freely: green means it worked and red
 * means it did not, in every shop. They were hex literals inside
 * `storeThemeVars` and were about to be written a second time by the
 * template contract; this is the one place they are decided.
 */
export const STATE_COLORS = Object.freeze({
  success: '#00a651',
  warning: '#f59e0b',
  danger: '#fb323f',
});

const INK = '#121926';
const PAPER = '#ffffff';

/**
 * Ink or paper on this colour — whichever is actually READABLE on it, by
 * measured contrast rather than by a lightness threshold.
 *
 * A threshold gets the easy cases right and fails the ones in the middle,
 * which is where most brand colours live. A yellow button with white text
 * is a button nobody reads, and so is a mid-green one.
 */
export function readableOn(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return PAPER;
  const bg = luminance(rgb);
  const onInk = contrast(bg, luminance(parseHex(INK)!));
  const onPaper = contrast(bg, luminance(parseHex(PAPER)!));
  return onInk >= onPaper ? INK : PAPER;
}

/**
 * WCAG contrast between two colours, 1–21.
 *
 * The maths was already here and already trusted — `readableOn` picks ink
 * or paper by measuring it rather than by guessing at a lightness
 * threshold. It was private, so the one thing that could not be done with
 * it was the thing a template contract needs: to REFUSE a pair. A rule
 * that cannot be called cannot be tested.
 *
 * An unparseable colour answers 1 — the worst possible ratio — so a
 * malformed hex fails a contrast check instead of sailing through it.
 */
export function contrastRatio(a: string, b: string): number {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (!ra || !rb) return 1;
  return contrast(luminance(ra), luminance(rb));
}

/**
 * THE NEAREST COLOUR THAT PASSES — because «مرفوض» is half an answer.
 *
 * «اللون الساقط بالتباين بينرفض مع أقرب لون ناجح». A seller who picks a
 * colour and is told only that it fails has been given a locked door and
 * no key: they will try a slightly different one, be refused again, and
 * conclude the system does not want them to choose colours. A refusal that
 * carries a working alternative is a refusal somebody can act on in one
 * press.
 *
 * NEAREST MEANS NEAREST IN LIGHTNESS, AND THE HUE IS KEPT. The seller
 * chose that hue; it is their brand, and a suggestion that changed it
 * would be this system picking the colour. What fails a contrast check is
 * almost always the lightness, and `atLightness` walks it in OKLab, where
 * equal steps look equal — so the first passing step really is the nearest
 * one a person would see.
 *
 * BOTH DIRECTIONS, AND THE CLOSER ONE WINS. A mid-grey text on a mid-grey
 * card can be fixed by going darker or lighter, and which is nearer
 * depends on the background. Walking outward from the colour's own
 * lightness and taking the first hit answers that without deciding it in
 * advance.
 *
 * It returns the colour itself when it already passes, and null when no
 * lightness of this hue reaches the ratio — which is rare and real: on a
 * mid-grey background there are hues where nothing works, and saying so is
 * better than offering a colour that still fails.
 */
export function nearestPassing(colour: string, against: string, min = 4.5): string | null {
  // AN EARLY EXIT, NOT A RULE. Removing this line changes no answer:
  // `contrastRatio` reads an unparseable colour as 1:1 and
  // `atLightness` hands it straight back, so the walk below runs two
  // hundred times and returns null anyway. A mutation that deleted it
  // was CAUGHT by nothing, and that is the honest reading — it is here
  // for the two hundred iterations, and because a future `atLightness`
  // that invented a colour for garbage would otherwise be believed.
  if (!isValidHex(colour) || !isValidHex(against)) return null;
  if (contrastRatio(colour, against) >= min) return colour;

  const from = lightnessOf(colour);
  // 1/200 of the lightness range: finer than a person can distinguish on a
  // screen, so the answer is "the nearest one" and not "the nearest of
  // twenty I happened to try".
  const STEP = 0.005;
  for (let d = STEP; d <= 1; d += STEP) {
    for (const l of [from - d, from + d]) {
      if (l < 0 || l > 1) continue;
      const candidate = atLightness(colour, l);
      if (contrastRatio(candidate, against) >= min) return candidate;
    }
  }
  return null;
}

export function isValidHex(hex: string): boolean {
  return parseHex(hex) !== null;
}

// ─────────────────────────────────────────────────────
// The palette a page is built from
// ─────────────────────────────────────────────────────

export interface Palette {
  accent: string;
  accentText: string;
  accentDark: string;
  accentTint: string;
  accentBorder: string;
  pageBg: string;
  cardBg: string;
  /**
   * The third surface: a strip, a filter sheet, a quiet row behind a card.
   *
   * Two surfaces are enough for a landing page, which is one column of
   * blocks on paper. A catalogue is not — a product grid on the page
   * colour, a card on top of it, and a sort bar that has to read as
   * neither, are three layers and the third had nowhere to come from. It
   * is derived like the rest: a hair away from the page's own colour, in
   * the page's own hue, so a warm shop stays warm.
   */
  surface2: string;
  text: string;
  muted: string;
  border: string;
  radius: string;
  fontStack: string;
  headingWeight: number;
  /** The backdrop layer, ready for `background-image`, or '' for none. */
  pageBackdrop: string;
}

const MOOD_BASE: Record<ThemeMood, { pageBg: string; cardBg: string; text: string; muted: string; border: string; headingWeight: number }> = {
  clean: { pageBg: '#ffffff', cardBg: '#ffffff', text: '#121926', muted: '#697586', border: '#e3e8ef', headingWeight: 800 },
  warm:  { pageBg: '#fdfaf6', cardBg: '#ffffff', text: '#1c1917', muted: '#78716c', border: '#eadfd3', headingWeight: 800 },
  bold:  { pageBg: '#ffffff', cardBg: '#ffffff', text: '#0b0f19', muted: '#4b5563', border: '#d1d5db', headingWeight: 900 },
  calm:  { pageBg: '#f8fafc', cardBg: '#ffffff', text: '#1e293b', muted: '#64748b', border: '#e2e8f0', headingWeight: 700 },
};

/** Everything the page needs to paint itself, derived from one colour. */
export function paletteFor(theme: Partial<LandingTheme> | null | undefined): Palette {
  const t = { ...DEFAULT_THEME, ...(theme ?? {}) };
  const accent = isValidHex(t.accent) ? t.accent : DEFAULT_THEME.accent;
  const base = MOOD_BASE[t.mood] ?? MOOD_BASE.clean;
  const fontStack = stackFor(t.font) || FONTS[0].stack;

  return {
    accent,
    accentText: readableOn(accent),
    // Pressed and hovered states: the same hue, one step down.
    accentDark: atLightness(accent, Math.max(0.2, lightnessOf(accent) - 0.12)),
    // A wash for badges and selected rows — pale enough for dark text on it.
    accentTint: atLightness(accent, 0.96, 0.18),
    accentBorder: atLightness(accent, 0.86, 0.45),
    ...base,
    // Toward the ink on paper, away from it on a dark page: a third surface
    // has to be VISIBLE against the first, whichever direction that is.
    surface2: atLightness(
      base.pageBg,
      lightnessOf(base.pageBg) > 0.5
        ? Math.max(0, lightnessOf(base.pageBg) - 0.035)
        : Math.min(1, lightnessOf(base.pageBg) + 0.05)
    ),
    radius: t.corners === 'sharp' ? '4px' : '14px',
    fontStack,
    // The veil goes in the SAME background-image, above the photo: one
    // property, no extra element, and nothing for a block to sit under by
    // accident. Both stops are the page's own paper colour, so the veil
    // tints toward the page rather than washing it grey.
    pageBackdrop: backdropFor(t.pageImage, t.pageVeil, base.pageBg),
  };
}

/**
 * The page's backdrop as one `background-image` value.
 *
 * Refuses anything that is not a same-origin path, the same rule the schema
 * carries — a value can reach here from an older row that was stored before
 * the rule existed, and a page is not the place to find that out.
 */
function backdropFor(image: string | undefined, veil: number | undefined, paper: string): string {
  if (!image || !/^\/[A-Za-z0-9/_.\-]*$/.test(image)) return '';
  const a = Math.min(0.95, Math.max(0, veil ?? 0.82));
  const rgb = parseHex(paper);
  const tint = rgb
    ? `rgba(${rgb.map((v) => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255)).join(',')},${a})`
    : `rgba(255,255,255,${a})`;
  return `linear-gradient(${tint}, ${tint}), url("${image}")`;
}

/** The palette as CSS custom properties, for a style attribute. */
export function paletteVars(palette: Palette): Record<string, string> {
  return {
    '--store-accent': palette.accent,
    '--store-accent-text': palette.accentText,
    '--store-accent-dark': palette.accentDark,
    '--store-accent-tint': palette.accentTint,
    '--store-accent-border': palette.accentBorder,
    '--store-page': palette.pageBg,
    '--store-card': palette.cardBg,
    '--store-surface-2': palette.surface2,
    '--store-text': palette.text,
    '--store-muted': palette.muted,
    '--store-border': palette.border,
    '--store-radius': palette.radius,
    '--store-font': palette.fontStack,
    '--store-heading-weight': String(palette.headingWeight),
    // `none` rather than omitting the variable: the stylesheet's fallback
    // then has nothing to guess, and turning the photograph off is one
    // value changing rather than a rule appearing and disappearing.
    '--store-page-image': palette.pageBackdrop || 'none',
  };
}
