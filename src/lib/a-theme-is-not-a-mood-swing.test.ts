import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_THEME, SYSTEM_THEMES, openingTheme, themeByKey } from './system-themes';
import { DECOR_CLASS, DECOR_LEVELS, DEFAULT_DECOR, decorCss, sanitizeDecor } from './theme-decoration';
import { CARD_CLASS, SHAPES, shapeCss, shapeOf } from './theme-shape';
import { repoFile, stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A THEME MOVES THE SURFACE. IT DOES NOT MOVE THE WORK.
 *
 * Nine of the twelve palettes are MOODS — neon, gold, parchment, a sky
 * with no moon — and a mood that is only thirty-four hexes is a
 * recoloured spreadsheet. So each theme may also change the shape of a
 * card and put an ambient touch on a screen.
 *
 * And then three lines the owner drew himself, which this file holds:
 *
 *   1. «ولا رسمة ورا رقم أو مبلغ.» Nothing is drawn behind a figure.
 *      Decoration lives in three places and on the welcome card; the
 *      shape is the card's FRAME — its corner, its edge, a glyph in the
 *      corner furthest from the heading.
 *   2. «الترتيب بيضل لصاحبه، والثيم للشكل بس.» A person arranges their
 *      dashboard, then changes theme. If the theme re-ordered anything,
 *      it would have eaten their work.
 *   3. No mark, character or likeness belonging to any game, show or
 *      living person — a blocker in the brief, not a preference.
 * ═══════════════════════════════════════════════════════════════════════
 */

const SRC = join(process.cwd(), 'src');

/**
 * The glyph's SVG, decoded out of the rule.
 *
 * Decoding the WHOLE rule throws: `clip-path:polygon(... 100% ...)` carries
 * per-cent signs, and `%` followed by two non-hex characters is a malformed
 * URI. Only the `data:` payload is percent-encoded, so only it is decoded.
 */
function markSvg(css: string): string {
  const m = /data:image\/svg\+xml,([^"]+)/.exec(css);
  return m ? decodeURIComponent(m[1]) : '';
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(full) && !/\.test\.tsx$/.test(full)) out.push(full);
  }
  return out;
}

describe('the ambient layer, and the three places it is allowed', () => {
  it('is drawn by exactly the three — and by the card that carries no figure', () => {
    /*
     * A sweep rather than a list of files to check: the point is that a
     * FOURTH place cannot appear without this failing. Every file that
     * renders `<ThemeDecor` is named here, and the set is closed.
     */
    const drawn = walk(SRC)
      .filter((f) => /<ThemeDecor\b/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'))
      .sort();
    expect(drawn, 'الزخرفة ظهرت بمكان رابع').toEqual([
      'components/shell/BrandStage.tsx',
      'components/shell/Sidebar.tsx',
      'components/ui/EmptyState.tsx',
    ]);
  });

  it('and not one screen that renders orders, money or stock draws it', () => {
    /*
     * The sweep the rule actually needs. A glow under a column of numbers
     * is a glow somebody reads through, every row, all day, while deciding
     * whether to ship something.
     */
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const body = stripComments(readFileSync(file, 'utf8'));
      if (!/<ThemeDecor\b/.test(body) && !new RegExp(`['"\`\\s]${DECOR_CLASS}[\\s'"\`]`).test(body)) continue;
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      if (rel === 'components/shell/ThemeDecor.tsx') continue;
      const data = /<Money\b|totalAmount|codAmount|quantity|availableStock|<Rows\b|<table/.test(body);
      if (data) offenders.push(rel);
    }
    expect(offenders, `زخرفة على شاشة فيها أرقام:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('and «off» writes no CSS at all, so turning it off is not hiding it', () => {
    for (const theme of SYSTEM_THEMES) {
      expect(decorCss(theme, 'off'), theme.key).toBe('');
    }
  });

  it('and «light» is static — nothing to pause, nothing to switch off', () => {
    const css = decorCss(themeByKey('cyber'), 'light');
    expect(css).toContain(DECOR_CLASS);
    expect(css, 'المستوى الخفيف فيه حركة').not.toContain('animation');
    expect(css).not.toContain('keyframes');
  });

  it('and «full» is killed by reduced motion and paused by a hidden tab', () => {
    const css = decorCss(themeByKey('cyber'), 'full');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    // Killed, not slowed: `animation:none` and not a longer duration.
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion'));
    expect(reduced).toContain('animation:none');
    expect(css, 'الحركة بتضلّ شغّالة والنافذة مخفيّة').toContain('[data-decor-hidden]');
    expect(css).toContain('animation-play-state:paused');
  });

  it('and takes its colours from the theme, never a hex of its own', () => {
    for (const theme of SYSTEM_THEMES) {
      for (const level of DECOR_LEVELS) {
        const css = decorCss(theme, level);
        expect(css, `${theme.key}/${level}: لون مكتوب بالإيد`).not.toMatch(/#[0-9a-fA-F]{3,8}/);
        expect(css, `${theme.key}/${level}: rgb() بالإيد`).not.toMatch(/\brgba?\(/);
      }
    }
  });

  it('and «خفيفة» is the default, so somebody who never opens settings has one', () => {
    expect(DEFAULT_DECOR).toBe('light');
    expect(sanitizeDecor('midnight')).toBe('light');
    expect(sanitizeDecor(null)).toBe('light');
    expect(sanitizeDecor('off'), 'اختيارٌ صحيح انقلب إلى الافتراضي').toBe('off');
  });
});

describe('the shape of a card — the frame, and nothing under the figure', () => {
  it('leaves the three the product came with exactly as they were', () => {
    // This is an addition to nine themes, not a restyle of the product.
    for (const key of ['ops', 'day', 'calm']) {
      expect(shapeCss(themeByKey(key)), key).toBe('');
    }
  });

  it('and gives each of the nine a corner, an edge and a glyph', () => {
    // 18/11/2026 (R1): «نظيف» joins the plain ones — a card with the product's own corner and
    // no glyph is the point of that palette (it has its own slot in SHAPES, held by
    // a-clean-palette.test.tsx). Was: only ops, day and calm were exempt.
    for (const theme of SYSTEM_THEMES.filter((t) => !['ops', 'day', 'calm', 'clean'].includes(t.key))) {
      const css = shapeCss(theme);
      expect(css, `${theme.key}: بلا شكل`).toContain(`.${CARD_CLASS}`);
      expect(css, `${theme.key}: بلا زاوية`).toContain('border-radius:');
      expect(css, `${theme.key}: بلا رمز`).toContain('background-image:');
      expect(shapeOf(theme.key).mark.length, `${theme.key}: الرمز فاضي`).toBeGreaterThan(10);
    }
  });

  it('and the glyph sits in the corner furthest from the heading, at 7%', () => {
    /*
     * RTL: the heading starts at the right edge, so the top-LEFT corner is
     * the one no word and no figure reaches. 22px inset 10px, at 7% of a
     * colour that is already the card's own border — it cannot be mistaken
     * for «needs attention» and cannot move the contrast of anything
     * drawn over it.
     */
    for (const theme of SYSTEM_THEMES) {
      const css = shapeCss(theme);
      if (!css) continue;
      expect(css, `${theme.key}: الرمز مش بالزاوية البعيدة`).toContain('background-position:left 10px top 10px');
      expect(css).toContain('background-size:22px 22px');
      expect(markSvg(css), `${theme.key}: الرمز مش باهت`).toContain('opacity="0.07"');
    }
  });

  it('and the glyph is drawn in a BORDER colour, never in a meaning', () => {
    for (const theme of SYSTEM_THEMES) {
      const css = markSvg(shapeCss(theme));
      if (!css) continue;
      expect(css, `${theme.key}`).toContain(theme.vars['border-strong']);
      for (const meaning of ['warning', 'destructive', 'success'] as const) {
        expect(css, `${theme.key}: الرمز بلون دلاليّ`).not.toContain(theme.vars[meaning]);
      }
    }
  });

  it('and it is a BACKGROUND — behind everything, clicking nothing, saying nothing', () => {
    /*
     * Not a pseudo-element over the content, and not an <img> in the
     * markup. A decoration a screen reader announces, or that swallows a
     * press meant for the card under it, has stopped being decoration.
     */
    for (const theme of SYSTEM_THEMES) {
      const css = shapeCss(theme);
      if (!css) continue;
      expect(css, `${theme.key}: رمز أمام المحتوى`).not.toMatch(/::after\s*\{[^}]*background-image/);
      if (css.includes('::before')) expect(css, `${theme.key}`).toContain('pointer-events:none');
    }
    const comp = repoFile('src/components/shell/ThemeDecor.tsx');
    expect(comp).toContain('aria-hidden');
  });

  it('and no theme carries a mark, a character or a likeness', () => {
    /*
     * A blocker in the brief, not a preference. What is in `SHAPES` is
     * geometry: circles, a crescent, an eight-point seal, a ring, a four
     * point rose, a shield outline, a cut gem. The sweep is for the names
     * — a path cannot be checked by a test, but a file that starts
     * naming things can.
     */
    const src = repoFile('src/lib/theme-shape.ts').toLowerCase();
    for (const word of ['pokemon', 'mario', 'luffy', 'batman', 'disney', 'nike', 'adidas', 'marvel']) {
      expect(src, `اسم علامة في ملفّ الأشكال: ${word}`).not.toContain(word);
    }
    for (const theme of SYSTEM_THEMES) {
      expect(shapeOf(theme.key).mark, `${theme.key}: صورة بدل شكل`).not.toContain('<image');
      expect(shapeOf(theme.key).mark, `${theme.key}: صورة بدل شكل`).not.toContain('href');
    }
  });

  it('and reaches the shared card only — not every surface wearing the card colour', () => {
    // An input and a badge wear that colour too, and a 22px crescent
    // inside a 32px field is not a theme, it is a defect.
    for (const theme of SYSTEM_THEMES) {
      const css = shapeCss(theme);
      if (!css) continue;
      expect(css, `${theme.key}: قاعدة بتمسك كلّ إشي بلون الكرت`).not.toContain('[class*=');
    }
    expect(stripComments(repoFile('src/components/ui/Card.tsx'))).toContain('CARD_CLASS');
  });
});

describe('and the arrangement is not a theme’s business', () => {
  it('— the owner ruled on it, and nothing here touches an order', () => {
    /*
     * «الترتيب بيضل لصاحبه، والثيم للشكل بس.» Somebody arranges their
     * dashboard, then changes theme; a theme that re-ordered anything
     * would have eaten their work. Neither shape nor decoration may so
     * much as mention the arrangement.
     */
    // `/(^|[;{\s])order:/` and not `'order:'`: the plain substring is inside
    // `border:`, which every one of these rules sets. A guard that fails on
    // the thing it is meant to allow gets deleted by the next person.
    const forbidden = [/(^|[;{\s])order:/, /flex-direction/, /grid-template/, /nav-arrangement/];
    for (const file of ['src/lib/theme-shape.ts', 'src/lib/theme-decoration.ts']) {
      const src = stripComments(repoFile(file));
      for (const f of forbidden) {
        expect(src, `${file} يلمس الترتيب: ${f}`).not.toMatch(f);
      }
    }
  });
});

describe('a role opens on a look, and it is a base not a cage', () => {
  it('reads the person’s own choice first, then the role’s, then the default', () => {
    expect(openingTheme('cyber', 'lux')).toBe('cyber');
    expect(openingTheme(null, 'lux')).toBe('lux');
    expect(openingTheme(null, null)).toBe(DEFAULT_THEME);
    expect(openingTheme(undefined, undefined)).toBe(DEFAULT_THEME);
  });

  it('and asks «did they choose» BEFORE «is it valid»', () => {
    /*
     * `sanitizeTheme` answers «the default» for anything it does not know,
     * including null. Running the person's null through it first would
     * return the default, and the role's base would never be reached — a
     * feature that silently does nothing, which is the worst kind.
     */
    expect(openingTheme(null, 'sea')).toBe('sea');
    // And a stored typo in either place still cannot blank a screen.
    expect(openingTheme('midnight', 'sea')).toBe(DEFAULT_THEME);
    expect(openingTheme(null, 'midnight')).toBe(DEFAULT_THEME);
  });

  it('and the door clears to NULL, never to the default’s key', () => {
    /*
     * «nobody chose» and «somebody chose the default» are different facts
     * the day the default moves: the first should move with it, the second
     * should not.
     */
    const src = stripComments(repoFile('src/app/api/roles/[id]/theme/route.ts'));
    expect(src).toMatch(/theme = null/);
    expect(src, 'الباب بيكتب الافتراضي بدل الفراغ').not.toContain('DEFAULT_THEME');
  });

  it('and is set by the permission that already decides what a role is', () => {
    const src = stripComments(repoFile('src/app/api/roles/[id]/theme/route.ts'));
    expect(src).toContain("requirePermission('roles.edit')");
    // A role from another company is not found, rather than written to.
    expect(src).toMatch(/findFirst\(\{\s*where: \{ id, companyId \}/);
  });

  it('and the layout actually resolves it, on every page', () => {
    const layout = stripComments(repoFile('src/app/(system)/layout.tsx'));
    expect(layout).toContain('openingTheme(user?.systemTheme, user?.roleTheme)');
  });
});
