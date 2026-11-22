import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { stripComments } from './guard-source';
import { join } from 'node:path';
import {
  AUTO_DARK,
  AUTO_LIGHT,
  AUTO_THEME,
  CHART_SERIES,
  DEFAULT_THEME,
  SYSTEM_THEMES,
  SYS_VARS,
  SHEET_THEMES,
  sanitizeTheme,
  themeByKey,
  themeStyle,
} from './system-themes';

/**
 * THREE LOOKS, ONE MEANING PER COLOUR.
 *
 * People here work at speed and read colour before they read words. A theme
 * that made red mean something else in the dark palette would make somebody
 * miss a late shipment at four in the afternoon because they switched theme
 * at lunch. So the surfaces move and the meanings do not, and that is what
 * is actually tested below — not that the palettes are pretty.
 */

const css = () => readFileSync(join(process.cwd(), 'src', 'app', '(system)', 'system.css'), 'utf8');

/** Very rough hue of a hex, 0–360. Enough to tell red from green. */
function hue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** Relative luminance, for contrast. */
function luminance(hex: string): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('the palettes', () => {
  it('there are fourteen palettes, and the default is one of them', () => {
    // Three were the product's own; eight are the owner's, from his PC
    // application; the twelfth, «ساحل النيون», is the one with photographs
    // (21/10). Every gate below runs over all of them.
    // 18/11/2026 (R1): 13 → 14. The fourteenth is «نظيف» (`clean`): a light page, a dark
    // menu, one colour — added to the END of the list, beside no other palette's values
    // (`a-clean-palette.test.tsx` holds the thirteen older ones byte for byte), and it is
    // not the default, not an automatic pick and not the new staff's look (that is R5).
    expect(SYSTEM_THEMES).toHaveLength(14);
    expect(themeByKey(DEFAULT_THEME).key).toBe(DEFAULT_THEME);
  });

  /** Everything in the list that is a colour. The rest is depth. */
  const DEPTH = ['shadow-raised', 'shadow-overlay'];

  it('every theme defines every colour — a missing one renders invisible text', () => {
    for (const theme of SYSTEM_THEMES) {
      for (const name of SYS_VARS) {
        if (DEPTH.includes(name)) continue;
        expect(theme.vars[name], `${theme.key}: --sys-${name}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('and every theme has its own depth, because a shadow is not portable', () => {
    // A 10%-black shadow is a soft edge on white and is literally nothing
    // on a near-black page. One shadow for three themes means one theme
    // where the cards do not separate from the page at all.
    for (const theme of SYSTEM_THEMES) {
      for (const name of DEPTH) {
        expect(theme.vars[name], `${theme.key}: --sys-${name}`).toMatch(/\d+px .*rgb\(/);
      }
    }
    const resting = SYSTEM_THEMES.map((t) => t.vars['shadow-raised']);
    expect(new Set(resting).size, 'الأقلمة الثلاث تتقاسم ظلاً واحداً').toBe(SYSTEM_THEMES.length);
  });

  it('and defines nothing extra, so a stray variable cannot hide unused', () => {
    for (const theme of SYSTEM_THEMES) {
      expect(Object.keys(theme.vars).sort()).toEqual([...SYS_VARS].sort());
    }
  });
});

describe('a colour means the same thing in all three', () => {
  it('destructive is red everywhere — late, or money lost', () => {
    for (const theme of SYSTEM_THEMES) {
      const h = hue(theme.vars.destructive);
      expect(h < 25 || h > 335, `${theme.key}: ${theme.vars.destructive}`).toBe(true);
    }
  });

  it('success is green everywhere — collected', () => {
    for (const theme of SYSTEM_THEMES) {
      const h = hue(theme.vars.success);
      expect(h, `${theme.key}: ${theme.vars.success}`).toBeGreaterThan(90);
      expect(h, `${theme.key}: ${theme.vars.success}`).toBeLessThan(175);
    }
  });

  it('warning is amber everywhere — needs attention', () => {
    for (const theme of SYSTEM_THEMES) {
      const h = hue(theme.vars.warning);
      expect(h, `${theme.key}: ${theme.vars.warning}`).toBeGreaterThan(20);
      expect(h, `${theme.key}: ${theme.vars.warning}`).toBeLessThan(60);
    }
  });

  it('and none of the four semantic colours is reused for another', () => {
    for (const theme of SYSTEM_THEMES) {
      const four = [theme.vars.primary, theme.vars.destructive, theme.vars.success, theme.vars.warning];
      expect(new Set(four).size, theme.key).toBe(4);
    }
  });
});

describe('legible in the theme it lives in', () => {
  const READABLE = 4.5;
  const LARGE = 3;

  it('body text on the page, and on a card', () => {
    for (const theme of SYSTEM_THEMES) {
      expect(contrast(theme.vars.foreground, theme.vars.background), `${theme.key} page`).toBeGreaterThan(READABLE);
      expect(contrast(theme.vars.foreground, theme.vars.card), `${theme.key} card`).toBeGreaterThan(READABLE);
    }
  });

  it('a heading on a card', () => {
    for (const theme of SYSTEM_THEMES) {
      expect(contrast(theme.vars.heading, theme.vars.card), theme.key).toBeGreaterThan(READABLE);
    }
  });

  /**
   * AND THE DIM TEXT, WHICH NOBODY WAS CHECKING.
   *
   * This file already asked about `foreground`, `heading`, the button's
   * label and the sidebar — and never about the two tones that paint the
   * SMALL text: a KPI's caption, a date under a row, «هامش الربح».
   *
   * A browser measured them at 4.06, 2.79 and 2.50 against the surface they
   * sit on. Three themes, all failing, for a year, because a guard that
   * covers four pairs reads as a guard that covers contrast.
   *
   * BOTH TONES, ON ALL THREE SURFACES a card can be. `--sys-muted` is the
   * dimmer of the two and it is still TEXT — dim is a hierarchy, not a
   * licence to be unreadable. Anything genuinely decorative uses an icon's
   * colour or a border token, neither of which is asked about here.
   */
  it('the dim text, on every surface it is allowed to sit on', () => {
    for (const theme of SYSTEM_THEMES) {
      for (const tone of ['muted', 'muted-foreground'] as const) {
        for (const on of ['card', 'surface', 'background'] as const) {
          expect(
            contrast(theme.vars[tone], theme.vars[on]),
            `${theme.key}: ${tone} على ${on}`
          ).toBeGreaterThan(READABLE);
        }
      }
    }
  });

  /** And the dimmer tone stays visibly dimmer, or the hierarchy is a lie. */
  it('and the two dim tones are still two', () => {
    for (const theme of SYSTEM_THEMES) {
      expect(
        theme.vars.muted.toLowerCase(),
        `${theme.key}: النبرتان الباهتتان صارتا واحدة`
      ).not.toBe(theme.vars['muted-foreground'].toLowerCase());
    }
  });

  it('the label on the action button', () => {
    for (const theme of SYSTEM_THEMES) {
      expect(
        contrast(theme.vars['primary-foreground'], theme.vars.primary),
        `${theme.key}: the button's own text`
      ).toBeGreaterThan(LARGE);
    }
  });

  /**
   * THE MENU, WHICH IS ON EVERY SCREEN AND WAS ON NO TEST.
   *
   * `sidebar` and `sidebar-foreground` were defined in all three palettes
   * and read by nothing: the sidebar painted itself from `heading`, which
   * is a TEXT colour. That worked while heading happened to be dark navy,
   * and stopped working the moment the dark theme made it near-white — a
   * near-white menu with pale blue-grey labels, measured at 1.84:1, on
   * every screen in the product.
   *
   * Contrast on the pair alone would not have caught it, because the pair
   * was fine and simply unused. So this asserts both halves: the colours
   * are readable, AND the component paints from them.
   */
  it('the menu that is on every screen, in every theme', () => {
    for (const theme of SYSTEM_THEMES) {
      expect(
        contrast(theme.vars['sidebar-foreground'], theme.vars.sidebar),
        `${theme.key}: قائمةٌ لا تُقرأ`
      ).toBeGreaterThan(READABLE);
      // The item you are standing on, which is the filled one.
      expect(
        contrast(theme.vars['primary-foreground'], theme.vars.primary),
        `${theme.key}: العنصر الحالي في القائمة`
      ).toBeGreaterThan(READABLE);
      // And hovering must not take the label somewhere unreadable.
      expect(
        contrast(theme.vars.heading, theme.vars['primary-soft']),
        `${theme.key}: التمرير فوق عنصر يخفي اسمه`
      ).toBeGreaterThan(READABLE);
    }
  });

  /**
   * 18/11/2026 (R4) — THE MENU'S OWN FIVE, MEASURED ON THE MENU.
   *
   * The menu borrowed five content colours (the tagline, the «AI», the
   * dividers, the hover wash, the label on hover). On «نظيف» — a light page
   * with a dark menu — the reviewer measured them at 2.07, 2.34 and 1.34:1.
   * Each now has a menu token, and each is pinned against the surface it is
   * drawn on in the menu, not on the page.
   */
  it('the menu’s own quiet text, accent and hover are readable on the menu, in every theme', () => {
    for (const theme of SYSTEM_THEMES) {
      const v = theme.vars;
      for (const text of ['sidebar-foreground', 'sidebar-muted', 'sidebar-accent'] as const) {
        expect(contrast(v[text], v.sidebar), `${theme.key}: ${text} على القائمة`).toBeGreaterThan(READABLE);
      }
      for (const text of ['sidebar-heading', 'sidebar-foreground'] as const) {
        expect(contrast(v[text], v['sidebar-hover']), `${theme.key}: ${text} على التمرير`).toBeGreaterThan(READABLE);
      }
    }
  });

  it('and the three looks the owner named are measured by name, so a palette list cannot drop one', () => {
    for (const key of ['clean', 'ops', 'islamic-epic']) {
      const v = themeByKey(key).vars;
      expect(themeByKey(key).key).toBe(key);
      expect(contrast(v['sidebar-muted'], v.sidebar), key).toBeGreaterThan(READABLE);
      expect(contrast(v['sidebar-accent'], v.sidebar), key).toBeGreaterThan(READABLE);
      expect(contrast(v['sidebar-foreground'], v['sidebar-hover']), key).toBeGreaterThan(READABLE);
    }
  });

  /*
   * The menu paints from the menu's tokens only. A content token in Sidebar.tsx is a colour measured
   * against the PAGE drawn on the MENU — the exact fault above. The one exception is the lit row's
   * pair, `bg-[var(--sys-primary)]` with its own text colour on the same line (pinned below and in
   * the wordmark test). Names are built from pieces so this file adds no class to the stylesheet.
   */
  /*
   * Every palette name that is not the menu's own is a CONTENT token here — `card`, `foreground`,
   * `surface`, the semantic colours, all of it — read by its exact name, so `border` is not
   * `sidebar-border`. `primary` and `primary-foreground` are allowed only as the lit row's pair:
   * every `--sys-primary` on a line must be a `bg-[var(--sys-primary)]` (so the arbitrary-colour form
   * `text-[color: var(--sys-primary)]` form is caught too — written with a space here: Tailwind scans this file, and
   * the unspaced form with an ellipsis became a class whose CSS did not parse, and every dev page answered 500). The one
   * other exception is the veil laid over the
   * PAGE behind the phone's open drawer (`bg-[var(--sys-background)]/60`): it is not on the menu.
   */
  const CONTENT_TOKENS = new Set(SYS_VARS.filter((n) => !n.startsWith('sidebar') && n !== 'primary-foreground'));
  const LIT = 'bg-[var(--sys-' + 'primary)]';
  const VEIL = 'bg-[var(--sys-' + 'background)]/60';
  function borrowed(code: string): string[] {
    const offenders: string[] = [];
    for (const line of code.split('\n')) {
      const names = [...line.matchAll(/--sys-([a-z0-9-]+)/g)].map((m) => m[1]);
      const lit = line.split(LIT).length - 1;
      let primaries = 0;
      for (const n of names) {
        if (n === 'primary') primaries += 1;
        else if (n === 'background' && line.includes(VEIL) && line.includes('fixed inset-0')) continue;
        else if (CONTENT_TOKENS.has(n as never)) offenders.push(`${n}: ${line.trim().slice(0, 90)}`);
      }
      if (primaries > lit) offenders.push(`primary not as the lit fill: ${line.trim().slice(0, 90)}`);
    }
    return offenders;
  }
  const sidebarCode = () =>
    stripComments(readFileSync(join(process.cwd(), 'src/components/shell/Sidebar.tsx'), 'utf8'));

  it('and Sidebar.tsx paints from no content token — only the lit row’s own pair', () => {
    expect(borrowed(sidebarCode()), 'القائمة تستعير لوناً من الصفحة').toEqual([]);
    for (const line of sidebarCode().split('\n')) {
      if (line.includes(LIT)) {
        expect(line, 'خلفية اللون المميّز بلا نصّه').toContain('text-[var(--sys-primary-foreground)]');
      }
    }
  });

  it('and the guard can tell: one borrowed colour, in any form, is caught', () => {
    // Built from pieces: a whole class written here would be a rule in the first-load sheet.
    const plant = (cls: string) => borrowed(`${sidebarCode()}\n<span className="${cls}" />`);
    expect(plant('text-[var(--sys-' + 'muted-foreground)]')).not.toEqual([]);
    expect(plant('text-[var(--sys-' + 'primary)]')).not.toEqual([]);
    expect(plant('text-[color:var(--sys-' + 'primary)]')).not.toEqual([]);
    expect(plant('bg-[var(--sys-' + 'card)]')).not.toEqual([]);
    expect(plant('text-[var(--sys-' + 'foreground)]')).not.toEqual([]);
    expect(plant('border-[var(--sys-' + 'border)]')).not.toEqual([]);
    expect(plant('bg-[var(--sys-' + 'background)]')).not.toEqual([]);
    // …and the menu's own names are not.
    expect(plant('border-[var(--sys-' + 'sidebar-border)]')).toEqual([]);
  });

  it('and the five measured faults are each painted from a menu token now', () => {
    const src = sidebarCode();
    expect(src, 'الـAI').toMatch(/Zaki <span className="text-\[var\(--sys-sidebar-accent\)\]">AI/);
    expect(src, 'السطر تحت الاسم').toMatch(/block text-xs text-\[var\(--sys-sidebar-muted\)\]/);
    expect(src, 'الخط تحت الرأس').toContain('border-b border-[var(--sys-sidebar-border)]');
    expect(src, 'التمرير').toContain('hover:bg-[var(--sys-sidebar-hover)]');
    expect(src, 'الاسم عند التمرير').toContain('hover:text-[var(--sys-sidebar-heading)]');
  });

  it('and the sidebar is actually painted from those two, not from a text colour', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/shell/Sidebar.tsx'), 'utf8');
    const surface = /bg-\[var\(--sys-sidebar\)\][^']*text-\[var\(--sys-sidebar-foreground\)\]/;
    expect(surface.test(src), 'القائمة لا تأخذ لونها من رمزَي القائمة').toBe(true);
    expect(src, 'لونُ نصٍّ يُستعمل خلفيةً للقائمة').not.toContain('bg-[var(--sys-heading)]');
  });

  /**
   * AND THE SAME MISTAKE ONE LAYER IN: THE WORDMARK.
   *
   * `--sys-primary-foreground` is the colour of text that sits ON the
   * accent — #04182B, a dark navy, so that cyan buttons are legible. The
   * brand lockup used it while sitting on the SIDEBAR (#0a1a2e), which is
   * 1.03:1. The product's own name was invisible, on every screen, in the
   * default theme — and it reads as empty padding rather than as a bug,
   * which is why a browser had to measure it.
   *
   * The rule is the general one: a foreground token belongs only on the
   * surface it was made for. `primary-foreground` goes on `primary`.
   */
  it('and the wordmark takes the sidebar’s foreground, not the accent’s', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/shell/Sidebar.tsx'), 'utf8');
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/^(\s*)\/\/.*$/gm, '$1');
    // The lockup: a bold wordmark, in the sidebar's own foreground.
    expect(
      /font-bold text-\[var\(--sys-sidebar-foreground\)\]/.test(stripped),
      'العلامة النصّيّة لا تأخذ لون القائمة'
    ).toBe(true);
    // `primary-foreground` may still appear — but only where a `primary`
    // background is on the same element, which is the item you stand on.
    for (const line of stripped.split('\n')) {
      if (!line.includes('--sys-primary-foreground')) continue;
      expect(
        line,
        `لونُ نصٍّ على اللون المميّز، بلا خلفيةٍ مميّزة:\n${line.trim().slice(0, 100)}`
      ).toContain('bg-[var(--sys-primary)]');
    }
  });

  it('and each semantic colour against the surface it is drawn on', () => {
    for (const theme of SYSTEM_THEMES) {
      expect(contrast(theme.vars.destructive, theme.vars['destructive-soft']), theme.key).toBeGreaterThan(LARGE);
      expect(contrast(theme.vars.success, theme.vars['success-soft']), theme.key).toBeGreaterThan(LARGE);
      expect(contrast(theme.vars.warning, theme.vars['warning-soft']), theme.key).toBeGreaterThan(LARGE);
    }
  });
});

/**
 * THE BRAND, AND THE ONE LINE IT MUST NOT BLUR.
 *
 * Zakai.io is navy, petrol and cyan. That puts the action colour in the
 * blue family — which is exactly why a blue "info" colour cannot exist
 * beside it: a notice painted the same family as a button is a notice
 * people try to press. An informational strip is surface-2 with secondary
 * text, and this refuses any re-introduction of the fourth colour.
 */
describe('the brand, and what it forbids', () => {
  it('has no informational colour at all — not in the list, not in the sheet', () => {
    expect([...SYS_VARS].filter((v) => v.startsWith('info'))).toEqual([]);
    for (const theme of SYSTEM_THEMES) {
      expect(Object.keys(theme.vars).filter((v) => v.startsWith('info')), theme.key).toEqual([]);
    }
    expect(css(), 'لونٌ معلوماتيّ عاد إلى ورقة الأنماط').not.toContain('--sys-info');
  });

  it('puts NAVY on the cyan accent in the dark theme, never white', () => {
    // White on the brand cyan measures 2.4:1 and fails outright; the navy
    // the brand already owns measures over 7:1. This is the single pair
    // most likely to be "tidied" back to white by somebody who has not
    // measured it.
    const dark = SYSTEM_THEMES.find((t) => t.dark)!;
    expect(contrast(dark.vars['primary-foreground'], dark.vars.primary)).toBeGreaterThan(4.5);
    expect(luminance(dark.vars['primary-foreground']), 'الكتابة على السماويّ صارت فاتحة').toBeLessThan(0.1);
  });

  it('and never puts an accent on white that cannot be read', () => {
    for (const theme of SYSTEM_THEMES.filter((t) => !t.dark)) {
      expect(
        contrast(theme.vars.primary, theme.vars.background),
        `${theme.key}: لون الفعل لا يُقرأ على الخلفية`
      ).toBeGreaterThan(4.5);
    }
  });

  it('gives every theme six chart series, none of them a semantic hue', () => {
    for (const theme of SYSTEM_THEMES) {
      const series = CHART_SERIES.map((k) => theme.vars[k]);
      expect(new Set(series).size, `${theme.key}: سلسلتان بلونٍ واحد`).toBe(6);
      for (const semantic of [theme.vars.warning, theme.vars.destructive, theme.vars.success]) {
        expect(series, `${theme.key}: سلسلة بلونٍ دلاليّ`).not.toContain(semantic);
      }
      // And each one has to be visible on the surface it is drawn on.
      for (const c of series) {
        expect(contrast(c, theme.vars.card), `${theme.key}: سلسلة باهتة على البطاقة`).toBeGreaterThan(3);
      }
    }
  });

  it('and a focus ring that can be seen on the page it sits on', () => {
    for (const theme of SYSTEM_THEMES) {
      expect(
        contrast(theme.vars.focus, theme.vars.background),
        `${theme.key}: حلقة التركيز غير مرئية`
      ).toBeGreaterThan(3);
    }
  });
});

describe('the stylesheet matches the palettes', () => {
  // The CSS is generated from these objects so the first paint is already
  // the right theme. Two copies of a palette is one palette that goes stale.
  it('the two the sheet carries are in it, every value', () => {
    const text = css();
    for (const key of SHEET_THEMES) {
      expect(text, `no block for ${key}`).toContain(`[data-sys-theme='${key}']`);
    }
    const dflt = themeByKey(DEFAULT_THEME);
    for (const name of SYS_VARS) {
      expect(text, `${dflt.key}: --sys-${name}`).toContain(`--sys-${name}: ${dflt.vars[name]};`);
    }
  });

  it('and the other nine are NOT in it — a palette nobody chose is weight on everybody', () => {
    /*
     * Every byte of system.css is in the first-load payload. Eleven
     * palettes is ten kilobytes of colours nine people in ten never see,
     * and `quality-gates.test.ts` caps the sheet for that reason — its own
     * message names this as the way down.
     */
    // Stripped, because the note left at the spot those palettes used to
    // occupy NAMES two of them — and a guard that reads its own prose is
    // the fault this repository has now made nine times.
    const text = stripComments(css());
    for (const theme of SYSTEM_THEMES) {
      if ((SHEET_THEMES as readonly string[]).includes(theme.key)) continue;
      expect(text, `قلمٌ لم يختره أحد في ورقة الأنماط: ${theme.key}`).not.toContain(
        `[data-sys-theme='${theme.key}']`
      );
    }
  });

  it('and every palette the sheet does not carry is written by the frame, whole', () => {
    // Whole: the selector, every one of the thirty-four values, and the
    // scheme its native controls are drawn in — in ONE rule, so a theme
    // whose surfaces are light and whose checkboxes are dark cannot exist.
    for (const theme of SYSTEM_THEMES) {
      if ((SHEET_THEMES as readonly string[]).includes(theme.key)) continue;
      const rule = themeStyle(theme.key);
      expect(rule, theme.key).toContain(`[data-sys-theme='${theme.key}']`);
      expect(rule, `${theme.key}: color-scheme`).toContain(`color-scheme:${theme.dark ? 'dark' : 'light'}`);
      for (const name of SYS_VARS) {
        expect(rule, `${theme.key}: --sys-${name}`).toContain(`--sys-${name}:${theme.vars[name]}`);
      }
    }
  });

  it('and writes nothing for the two it does carry, nor for a key it does not know', () => {
    // Declaring the default twice is how the two copies come to disagree.
    for (const key of SHEET_THEMES) expect(themeStyle(key), key).toBe('');
    expect(themeStyle('midnight')).toBe('');
    expect(themeStyle(null)).toBe('');
  });

  it('and the frame actually puts it in the document, beside the fonts', () => {
    const frame = stripComments(
      readFileSync(join(process.cwd(), 'src/app/(system)/SystemFrame.tsx'), 'utf8')
    );
    expect(frame).toContain('themeStyle(key)');
    expect(frame, 'القلم محسوبٌ ولا يُطبع').toMatch(/\$\{palette\}/);
  });

  it('and تلقائي resolves on the FIRST paint, by media query, not by script', () => {
    // A theme applied by script flashes the default first. A phone in night
    // mode would be shown a white screen at four in the morning, every time.
    const text = css();
    expect(text, 'لا كتلة للوضع التلقائي').toContain("[data-sys-theme='auto']");
    expect(text, 'الوضع التلقائي لا يسأل الجهاز').toContain('@media (prefers-color-scheme: light)');
    const light = SYSTEM_THEMES.find((t) => t.key === AUTO_LIGHT)!;
    const dark = SYSTEM_THEMES.find((t) => t.key === AUTO_DARK)!;
    // A light device is overridden explicitly...
    const auto = text.slice(text.indexOf('@media (prefers-color-scheme: light)'));
    expect(auto, 'الوضع التلقائي لا يحمل القلم الفاتح').toContain(`--sys-background: ${light.vars.background};`);
    // ...and a dark one inherits the default, which must BE the dark palette,
    // or `auto` would silently mean something else.
    expect(DEFAULT_THEME, 'الافتراضي لم يعد القلم الذي يرثه الوضع التلقائي').toBe(dark.key);
  });

  it('and :root is the default, so a page with no attribute still has colours', () => {
    expect(css()).toMatch(/:root,\s*\n\[data-sys-theme='ops'\]/);
  });
});

describe('what it refuses', () => {
  it('a key this build does not know becomes the default, never nothing', () => {
    expect(sanitizeTheme('midnight')).toBe(DEFAULT_THEME);
    expect(sanitizeTheme(null)).toBe(DEFAULT_THEME);
    expect(sanitizeTheme(42)).toBe(DEFAULT_THEME);
  });
});

/**
 * The point of all of it: a screen that hardcodes a colour does not change
 * when the theme does, so a dark theme with a hundred white cards in it is
 * not a dark theme. This is the guard that stops the next one being added.
 */
describe('no new hardcoded colour in a system screen', () => {
  const ROOTS = ['src/components/screens', 'src/components/ui', 'src/components/shell', 'src/components/settings'];
  /**
   * Files that legitimately hold a colour that is not the system's:
   *   a STORE's own look, a PRINTED page (a waybill must not change colour
   *   with a theme), or somebody else's BRAND — Telegram blue, WhatsApp
   *   green, a channel's own colour. A brand colour turned into the
   *   system's info colour stops looking like the brand, which is the one
   *   job it has.
   */
  const ALLOWED = /landingpageeditor|storetheme|storedesign|label|telegram|whatsapp|channelsscreen|trackingpixels/i;

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (p.endsWith('.tsx') && !p.includes('.test.')) out.push(p);
    }
    return out;
  }

  it('no hex, and no Tailwind palette colour', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(process.cwd(), root))) {
        if (ALLOWED.test(file)) continue;
        /**
         * COMMENTS STRIPPED FIRST — the fifth time this lesson has been
         * learned in this redesign. A note explaining WHY a colour was
         * wrong has to name the colour: «it was #04182B on #0a1a2e, which
         * is 1.03:1». The guard then finds those two hexes and reports the
         * fix as the defect.
         */
        const src = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
          .replace(/^(\s*)\/\/.*$/gm, '$1');
        const hex = src.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
        const palette =
          src.match(
            /\b(?:bg|text|border)-(?:white|slate|gray|rose|emerald|amber)-?(?:[0-9]{2,3})?\b/g
          ) ?? [];
        if (hex.length || palette.length) {
          offenders.push(`${file.split(/[\\/]/).slice(-2).join('/')}: ${[...hex, ...palette].slice(0, 4).join(' ')}`);
        }
      }
    }
    expect(offenders, `ألوان مثبَّتة لا تتبع المظهر:\n${offenders.join('\n')}`).toEqual([]);
  });
});

/**
 * A RECOMMENDATION IS NOT A LOSS.
 *
 * The assistant screen drew three boxes — observations, risks and
 * recommendations — and coloured all three with the destructive variable.
 * Red means "late, or money lost" everywhere else in this system, so a
 * screen that paints a recommendation red is teaching people to stop
 * reading red as urgent.
 */
describe('a semantic colour keeps its meaning on every screen', () => {
  it('the assistant does not paint its recommendations as losses', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/AssistantScreen.tsx'), 'utf8');
    const i = src.indexOf('<RiCheckboxCircleLine');
    expect(i, 'the recommendations box is gone').toBeGreaterThan(0);
    const box = src.slice(src.lastIndexOf('<div className="bg-[var(--sys-', i), i);
    expect(box.length, 'could not find the box markup').toBeGreaterThan(20);
    expect(box).not.toContain('sys-destructive');
  });

  it('and still paints its risks as risks', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/AssistantScreen.tsx'), 'utf8');
    const i = src.indexOf('<RiShieldFlashLine');
    const box = src.slice(src.lastIndexOf('<div className="bg-[var(--sys-', i), i);
    expect(box.length, 'could not find the box markup').toBeGreaterThan(20);
    expect(box).toContain('sys-destructive');
  });
});

/**
 * A THEME IS A SURFACE COLOUR *AND* A SCHEME.
 *
 *   «إذا كانت بيضا فتكون أزرق» · «التبويبات المنبثقة … غير متناسبة مع التصميم»
 *
 * A checkbox, a radio, a date picker's calendar, a number spinner and the
 * popup list a `<select>` opens are painted by the USER AGENT. Tailwind's
 * preflight zeroes their `background-color`, so a bare field's box is
 * transparent rather than white — but the widget inside it is still the
 * browser's, and a browser with no `color-scheme` to go on assumes light.
 *
 * Measured in Chrome on this build, on `--sys-card` (#0A1A2E): an unchecked
 * tick box rendered a WHITE square, a radio a white disc, and the date
 * field's calendar glyph near-black. Declaring the scheme turned all three
 * dark, and moved no explicitly-themed control by a pixel.
 *
 * `dark: boolean` on each theme is the source of truth here, exactly as
 * `vars` is for the palette above. Reading it rather than repeating it is
 * what stops a fourth palette being added with the scheme left behind —
 * which is the failure this whole family of complaints came from.
 */

/**
 * Every `color-scheme` declared in a rule whose selector names `selector`.
 *
 * A list rather than one value: `auto` is written twice — once on its own
 * and once inside the light media query — and a guard that silently took
 * the first would not notice the two disagreeing.
 */
export function declaredSchemes(css: string, selector: string): string[] {
  // `stripComments` is lib/guard-source.ts's, not a copy: that file exists
  // because the costliest bugs in this redesign were bugs in COPIES of it,
  // and one of them was this exact fault — a guard reading its own prose.
  // The ops rule's comment discusses schemes at length, so a reader that
  // counted prose would pass whatever the stylesheet actually did.
  const text = stripComments(css);
  const found: string[] = [];
  let i = text.indexOf(selector);
  while (i !== -1) {
    const open = text.indexOf('{', i);
    const close = text.indexOf('}', open);
    if (open === -1 || close === -1) break;
    const m = text.slice(open + 1, close).match(/color-scheme:\s*([^;]+);/);
    if (m) found.push(m[1].trim().replace(/\s+/g, ' '));
    i = text.indexOf(selector, close);
  }
  return found;
}

describe('every palette declares the scheme its native controls are drawn in', () => {
  it.each(SYSTEM_THEMES.map((t) => [t.key, t.dark] as const))(
    '%s declares the scheme matching its own dark flag',
    (key, dark) => {
      /*
       * READ WHERE THAT PALETTE ACTUALLY LIVES.
       *
       * Two of the eleven are in the stylesheet and nine are written into
       * the document by `SystemFrame` — see `SHEET_THEMES`. The claim is
       * the same for all eleven: whichever place a palette comes from, it
       * states the scheme its own native controls are drawn in.
       */
      const source = (SHEET_THEMES as readonly string[]).includes(key) ? css() : themeStyle(key);
      const schemes = declaredSchemes(source, `[data-sys-theme='${key}']`);
      expect(schemes, `لا color-scheme للقلم ${key}`).toContain(dark ? 'dark' : 'light');
    }
  );

  it('and the default root declares it too, so a page with no attribute is not left to the browser', () => {
    // `:root` shares the ops rule, so this asserts the pair, not a copy.
    expect(css()).toMatch(/:root,\s*\r?\n\[data-sys-theme='ops'\][\s\S]{0,2000}?color-scheme: dark;/);
  });

  it('تلقائي hands the scheme to the device, in both of its states', () => {
    // `light dark` is the one value that answers a dark device AND a light
    // one, which is what the palette below it does by media query. A flat
    // `dark` here would put white tick boxes back on a light device.
    expect(declaredSchemes(css(), "[data-sys-theme='auto']")).toEqual(['light dark']);
  });

  it('is declared inside the palette rule, never in a rule of its own', () => {
    // Co-located so the two cannot drift. A theme whose surfaces are light
    // and whose controls are dark is the bug this file exists to prevent,
    // and splitting the declaration out is how that happens.
    for (const theme of SYSTEM_THEMES) {
      const text = stripComments(css());
      const at = text.indexOf(`[data-sys-theme='${theme.key}']`);
      const block = text.slice(text.indexOf('{', at), text.indexOf('}', at));
      expect(block, theme.key).toContain('--sys-background:');
      expect(block, theme.key).toContain('color-scheme:');
    }
  });

  it('leaves the scroll bars alone, because they are painted explicitly', () => {
    // `color-scheme` repaints a scroll bar unless CSS already does. This
    // product does, so the declaration cannot move them — asserted because
    // it is the one visible thing a scheme change is most likely to break.
    expect(css()).toContain('::-webkit-scrollbar');
  });
});

describe('the scheme reader itself', () => {
  it('reads a declaration out of a block', () => {
    expect(declaredSchemes("[data-sys-theme='x'] { color-scheme: dark; --a: 1; }", "[data-sys-theme='x']")).toEqual(['dark']);
  });

  it('does not mistake a mention in a comment for a declaration', () => {
    // The ops block carries a long comment about schemes. A reader that
    // counted prose would pass whatever the CSS actually did.
    const css = "[data-sys-theme='x'] { /* color-scheme: dark; is what we want */ --a: 1; }";
    expect(declaredSchemes(css, "[data-sys-theme='x']")).toEqual([]);
  });

  it('reports a block that declares nothing', () => {
    expect(declaredSchemes("[data-sys-theme='x'] { --a: 1; }", "[data-sys-theme='x']")).toEqual([]);
  });

  it('collects every rule for the selector, not just the first', () => {
    const css = "[data-sys-theme='a'] { color-scheme: light dark; } @media x { [data-sys-theme='a'] { color-scheme: light; } }";
    expect(declaredSchemes(css, "[data-sys-theme='a']")).toEqual(['light dark', 'light']);
  });

  it('normalises the whitespace inside a value', () => {
    expect(declaredSchemes("[a] {\n  color-scheme:   light   dark;\n}", '[a]')).toEqual(['light dark']);
  });
});

/**
 * AND THE PROSE THAT JUSTIFIED THE OLD STATE.
 *
 * When `color-scheme` was undeclared, six comments across three files said
 * so — and said WHY the shared `Input` was used because of it. The
 * declaration landed; the comments did not. One of them even instructed the
 * reader: «Grep it: not in src/app/globals.css, not in
 * src/app/(system)/system.css, nowhere», which now fails the moment anybody
 * follows it.
 *
 * In this codebase the comments are the documentation — they are how a
 * reader learns that saved views were declined, that an action is not a
 * state, that a ledger leads with the date. A comment asserting a fact the
 * code contradicts sends the next person to fix what is already fixed, and
 * costs more than the silence would have.
 *
 * So the pair is held together: the declaration has a test above, and the
 * claim that there is no declaration cannot come back.
 */
describe('and nothing in the product still says the scheme is undeclared', () => {
  const CLAIM = /(nothing|not)\b[^.\n]{0,80}declares?\b[^.\n]{0,40}color-scheme|declares? no\b[^.\n]{0,20}color-scheme/i;

  /* `.ts` as well as `.tsx`: four of the six lived in test files. */
  const everySource = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...everySource(p));
      else if (/\.tsx?$/.test(p)) out.push(p);
    }
    return out;
  };

  const files = () => everySource(join(process.cwd(), 'src'));

  it('found files to check — a sweep over nothing proves nothing', () => {
    expect(files().length).toBeGreaterThan(200);
  });

  it('and no comment contradicts the declaration', () => {
    const offenders: string[] = [];
    for (const file of files()) {
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (CLAIM.test(lines[i])) {
          offenders.push(`${file.split('src')[1]}:${i + 1}  ${lines[i].trim().slice(0, 90)}`);
        }
      }
    }
    expect(
      offenders,
      `نصٌّ يقول إنّ color-scheme غيرُ معلَن — وهو معلَنٌ في كلّ لوحة:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
