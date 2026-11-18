import { describe, expect, it } from 'vitest';
import { SYSTEM_THEMES } from './system-themes';
import { CARD_CLASS, SHAPES, shapeCss, shapeOf } from './theme-shape';

/**
 * THE TWO ISLAMIC THEMES WEAR A FRIEZE ALONG THE TOP OF EVERY CARD (22/10).
 *
 * The owner, 21/10: «الشكل يكون خرافي مستوحى من الاسلامي حتى الرسوميات». Until now a card under «إسلامي» wore a pointed arch on its top
 * edge and a crescent at 7% in a corner — correct, and so quiet that a screenshot could not tell it from the plain theme. The frieze is
 * the part that can be seen: a band of eight-point stars and lozenges strung on a hairline, in the theme's own accent (the gold of one,
 * the green of the other), repeating along the top edge. Seen, on both palettes, before it was written.
 *
 * It is held to the lines the owner drew for every shape (`a-theme-is-not-a-mood-swing.test.ts`), restated for a band:
 *
 *   1. «ولا رسمة ورا رقم أو مبلغ.» — it is eight pixels tall and a BACKGROUND, so it sits in the card's top padding (`CardHeader` is
 *      16px from the edge; the first row of a full-bleed table card is 12px) beneath everything; it is a layer of the same background
 *      the mark is, never a pseudo-element over the content, so it catches no click and is announced to nobody.
 *   2. It is drawn in the theme's ACCENT and never in a colour that means something: a warning colour along every card is a screen
 *      that is always warning.
 *   3. It is GEOMETRY — a polygon, a diamond and a line. No image, no text, no mark of anybody's.
 *   4. It is the two Islamic themes' and nobody else's, and every other theme's card is written exactly as it was.
 */

const ISLAMIC = ['islamic-epic', 'islamic-calm'];
const themes = SYSTEM_THEMES.filter((t) => shapeCss(t) !== '');

/** Every SVG tile inside a rule, decoded. Only the `data:` payload is percent-encoded (`%` in a polygon would not survive a whole-rule decode). */
const tiles = (css: string) =>
  [...css.matchAll(/data:image\/svg\+xml,([^"]+)/g)].map((m) => decodeURIComponent(m[1]));

/** The card rule — the one that is not the crown and not the notch. */
const cardRule = (css: string) => css.split('}').find((r) => r.includes('background-image')) ?? '';

describe('who wears it', () => {
  it('— the two Islamic themes, and no other', () => {
    for (const t of SYSTEM_THEMES) {
      expect(!!shapeOf(t.key).frieze, t.key).toBe(ISLAMIC.includes(t.key));
    }
    expect(Object.keys(SHAPES).filter((k) => SHAPES[k].frieze).sort()).toEqual([...ISLAMIC].sort());
  });

  it('— each carries two tiles in its rule (the mark and the frieze), every other carries one, and the plain three none', () => {
    for (const t of SYSTEM_THEMES) {
      const count = tiles(shapeCss(t)).length;
      if (ISLAMIC.includes(t.key)) expect(count, t.key).toBe(2);
      // 18/11/2026 (R1): «نظيف» is a plain one too (was: only ops, day and calm) — see a-clean-palette.test.tsx.
      else if (['ops', 'day', 'calm', 'clean'].includes(t.key)) expect(count, t.key).toBe(0);
      else expect(count, t.key).toBe(1);
    }
  });

  it('— and a theme without it is written exactly as it was: one layer, the old four declarations', () => {
    const css = cardRule(shapeCss(SYSTEM_THEMES.find((t) => t.key === 'cyber')!));
    expect(css).toMatch(
      /;background-image:url\("data:image\/svg\+xml,[^"]+"\);background-repeat:no-repeat;background-position:left 10px top 10px;background-size:22px 22px$/
    );
  });
});

describe('it is a layer of the card’s own background, on the top edge, repeating along it', () => {
  for (const key of ISLAMIC) {
    const theme = SYSTEM_THEMES.find((t) => t.key === key)!;
    const css = shapeCss(theme);
    const rule = cardRule(css);

    it(`${key}: the mark first, the frieze second — two images, two repeats, two positions, two sizes`, () => {
      const lists = ['background-image', 'background-repeat', 'background-position', 'background-size'].map((p) => {
        const m = new RegExp(`${p}:([^;}]+)`).exec(rule);
        expect(m, `${key}: ${p}`).toBeTruthy();
        return m![1];
      });
      expect(lists[1]).toBe('no-repeat,repeat-x');
      expect(lists[2]).toBe('left 10px top 10px,left 0 top 0');
      expect(lists[3]).toBe('22px 22px,auto 8px');
      expect((lists[0].match(/url\(/g) ?? []).length).toBe(2);
    });

    it(`${key}: and it is NOT a pseudo-element — nothing is drawn over the content`, () => {
      for (const r of css.split('}')) {
        if (/::(before|after)/.test(r)) expect(r, `${key}: ${r.slice(0, 60)}`).not.toContain('data:image');
      }
    });

    it(`${key}: the crown is painted over it with the card’s own colour — the middle becomes a doorway`, () => {
      const crown = css.split('}').find((r) => r.includes('::before')) ?? '';
      expect(crown).toContain('background:var(--sys-card)');
    });
  }
});

describe('it keeps clear of every figure', () => {
  it('— eight pixels tall at most, inside the 12px a card’s first row is already from the edge, and not a busy pattern', () => {
    for (const key of ISLAMIC) {
      const f = shapeOf(key).frieze!;
      expect(f.h, key).toBeLessThanOrEqual(8);
      expect(f.w, `${key}: period`).toBeGreaterThanOrEqual(16);
      expect(f.h, key).toBeGreaterThan(3);
    }
  });

  it('— and it is quiet: between 40% and 70% of its colour, so it reads as a worked edge and not as a signal', () => {
    for (const key of ISLAMIC) {
      const svg = tiles(shapeCss(SYSTEM_THEMES.find((t) => t.key === key)!))[1];
      const opacity = Number(/opacity="([\d.]+)"/.exec(svg)![1]);
      expect(opacity, key).toBeGreaterThanOrEqual(0.4);
      expect(opacity, key).toBeLessThanOrEqual(0.7);
    }
  });
});

describe('it is drawn in the theme’s accent, and geometry only', () => {
  it('— the theme’s primary, never a colour that means something', () => {
    for (const key of ISLAMIC) {
      const theme = SYSTEM_THEMES.find((t) => t.key === key)!;
      const svg = tiles(shapeCss(theme))[1];
      expect(svg, key).toContain(`color="${theme.vars.primary}"`);
      for (const meaning of ['warning', 'destructive', 'success'] as const) {
        expect(svg, `${key}: بلون دلاليّ`).not.toContain(theme.vars[meaning]);
      }
    }
  });

  it('— the two palettes wear their OWN accent: gold on one, green on the other', () => {
    const [epic, calm] = ISLAMIC.map((k) => SYSTEM_THEMES.find((t) => t.key === k)!);
    expect(tiles(shapeCss(epic))[1]).not.toContain(calm.vars.primary);
    expect(tiles(shapeCss(calm))[1]).not.toContain(epic.vars.primary);
  });

  it('— a polygon, a diamond and a line: no image, no text, no link, no script', () => {
    for (const key of ISLAMIC) {
      const body = shapeOf(key).frieze!.body.toLowerCase();
      for (const bad of ['<image', 'href', '<text', '<script', 'xlink', 'onload', 'url(']) {
        expect(body, `${key}: ${bad}`).not.toContain(bad);
      }
      // A STAR: a real polygon element with sixteen points (eight tips, eight notches), a line, and a diamond.
      const star = /<polygon\s+points="([^"]+)"/.exec(body);
      expect(star, `${key}: بلا نجمة`).toBeTruthy();
      expect(star![1].trim().split(/\s+/).length, `${key}: نجمة بثمانِ رؤوس`).toBe(16);
      expect((body.match(/<path\s/g) ?? []).length, `${key}: خطٌّ ولوزة`).toBe(2);
    }
  });

  it('— and the corner mark is still what it was: first layer, 7%, in a border colour', () => {
    for (const key of ISLAMIC) {
      const theme = SYSTEM_THEMES.find((t) => t.key === key)!;
      const mark = tiles(shapeCss(theme))[0];
      expect(mark).toContain('opacity="0.07"');
      expect(mark).toContain(`color="${theme.vars['border-strong']}"`);
    }
  });
});

describe('and it costs the stylesheet nothing', () => {
  it('— it is written into the document with the one palette a person chose, never into the first-load sheet', () => {
    // `SystemFrame` is the only caller of `shapeCss`; the sheet carries no `zk-card` rule of any theme.
    expect(CARD_CLASS).toBe('zk-card');
    for (const t of themes) expect(shapeCss(t)).toContain(`[data-sys-theme='${t.key}'] .${CARD_CLASS}`);
  });
});
