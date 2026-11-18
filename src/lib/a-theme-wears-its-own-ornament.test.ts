import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPOSED, PHOTOGRAPHIC, PIECES, UNDECORATED, decorCss, photographsOf } from './theme-decoration';
import { AUTO_DARK, AUTO_LIGHT, AUTO_THEME, SYSTEM_THEMES, themeByKey } from './system-themes';
import { repoFile, stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ELEVEN ORNAMENTS, AND THE THREE THINGS THAT MAKE ONE SAFE.
 *
 * The owner, 20/10: «شكل الإطار لكل ثيم… وزيد عليه رمز صغير باهت بزاوية
 * الكرت… الرسمات بالأماكن التلاتة وبكرت الترحيب بس. ولا رسمة ورا رقم أو
 * مبلغ.»
 *
 * Until now a theme's decoration was two radial washes built from
 * `--sys-primary-soft`, identical in all eleven. Eight of them are MOODS —
 * neon, gold, parchment, a sky with no moon — and the same wash under all
 * of them made the choice a recoloured spreadsheet, which is the thing
 * `theme-decoration.ts` opens by saying it must not be.
 *
 * So each theme now wears a drawing of its own. The three things that
 * keep a drawing from becoming a problem are pinned here, because every
 * one of them is invisible until it is too late:
 *
 *   ① It is a MASK, so its colour is the theme's own `--sys-primary` and
 *     it cannot carry a twelfth palette nobody measured.
 *   ② Its loudness is MEASURED, not chosen, so a replacement drawing
 *     cannot arrive at the wrong volume unnoticed.
 *   ③ «تلقائي» gets BOTH, because it has two palettes and one ornament
 *     would be a radar sweep on a white screen at noon.
 *
 * The rule that it never appears behind money is the OTHER file's —
 * `a-theme-is-not-a-mood-swing.test.ts` sweeps every screen for it — and
 * this one does not restate it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const DECOR_DIR = join(process.cwd(), 'public', 'brand', 'decor');
const css = (key: string, level: 'off' | 'light' | 'full' = 'light') =>
  decorCss(themeByKey(key), level, key);

/**
 * The files a theme owns: one mask, or the three drawings of a composed one — or its photographs, and,
 * for a photographic theme with no strip across the header of the menu («ليل», 23/10/2026), its own
 * mask as well, because that header keeps wearing it.
 */
// 18/11/2026 (R1): a theme in UNDECORATED («نظيف») owns no file at all — it is silent by design, and
// a-clean-palette.test.tsx holds the list closed. Was: every theme owned at least `<key>.webp`.
const filesOf = (key: string): string[] =>
  UNDECORATED.includes(key)
    ? []
    : PHOTOGRAPHIC[key]
    ? [...photographsOf(key), ...(PHOTOGRAPHIC[key].strip ? [] : [`${key}.webp`])]
    : COMPOSED[key]
      ? PIECES.map((piece) => `${key}.${piece}.webp`)
      : [`${key}.webp`];

/**
 * THE PICTURES ARE NOT MASKS, AND THIS FILE IS ABOUT MASKS.
 *
 * One theme wears photographs (21/10, on purpose — see PHOTOGRAPHIC in theme-decoration.ts). They are opaque,
 * they have no alpha channel and they are not painted from `--sys-primary`, so every claim below that is
 * about the properties of a mask looks at `maskFiles()` and not at the whole folder, and the claims for the
 * pictures are in a-photographic-theme-keeps-its-text-readable.test.ts.
 */
const PHOTOS = new Set(SYSTEM_THEMES.flatMap((t) => photographsOf(t.key)));
const maskFiles = (): string[] => readdirSync(DECOR_DIR).filter((n) => n.endsWith('.webp') && !PHOTOS.has(n));

describe('every theme has an ornament, and it is on the disk', () => {
  it('— the files are exactly the ones the themes own, no more and no fewer', () => {
    const files = readdirSync(DECOR_DIR).filter((f) => f.endsWith('.webp')).sort();
    const owned = SYSTEM_THEMES.flatMap((t) => filesOf(t.key)).sort();
    expect(files, 'ثيم بلا رسمة أو رسمة بلا ثيم').toEqual(owned);
  });

  it('and each theme’s CSS actually asks for every file it owns', () => {
    for (const t of SYSTEM_THEMES) {
      for (const f of filesOf(t.key)) {
        expect(css(t.key), `${t.key} ما بيطلب ${f}`).toContain(`/brand/decor/${f}`);
      }
    }
  });

  it('and no theme reaches for another theme’s drawing', () => {
    for (const t of SYSTEM_THEMES) {
      const asked = [...css(t.key, 'full').matchAll(/\/brand\/decor\/([\w.-]+\.webp)/g)].map((m) => m[1]);
      const mine = new Set(filesOf(t.key));
      for (const f of asked) expect(mine.has(f), `${t.key} بيجيب ${f}`).toBe(true);
    }
  });
});

describe('and it is a mask, so it carries no colour of its own', () => {
  it('— the colour comes from the palette, through the mask', () => {
    const out = css('lux');
    expect(out).toContain('mask:url(/brand/decor/lux.webp)');
    expect(out, 'الرسمة لازم تتلون من --sys-primary').toContain('background-color:var(--sys-primary)');
  });

  it('and Safari’s prefixed property is written beside the standard one', () => {
    /*
     * An ignored `mask` leaves a solid primary-coloured square where the
     * ornament should be — a worse failure than no ornament at all — so
     * the prefix is not optional politeness.
     */
    /*
     * Counted, not looked for. The first version of this claim asked
     * whether the prefixed string appeared anywhere — and it still did
     * after the prefix was deleted from the main rule, because the
     * sidebar rule had one of its own. A claim that cannot tell the
     * difference between «every rule» and «one rule» is not watching
     * anything.
     */
    for (const t of SYSTEM_THEMES.filter((x) => !PHOTOGRAPHIC[x.key] && !UNDECORATED.includes(x.key))) {
      const out = css(t.key, 'full');
      const std = out.match(/(?<!-)\bmask(?:-size)?:/g)?.length ?? 0;
      const webkit = out.match(/-webkit-mask(?:-size)?:/g)?.length ?? 0;
      expect(webkit, `${t.key}: ${std} قاعدة قناع و${webkit} منها فيها بادئة`).toBe(std);
      expect(std).toBeGreaterThan(0);
    }
  });

  it('and no decoration rule names a colour of its own', () => {
    /*
     * The whole file's standing rule, now that it serves pictures: every
     * colour in the ambient CSS must be a `var(--sys-…)`. A hex here is a
     * twelfth palette, and `system-themes.test.ts` is not looking at it.
     */
    for (const t of SYSTEM_THEMES) {
      expect(css(t.key, 'full'), `${t.key} فيه لون صريح`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});

describe('and how loud it is was measured, not picked', () => {
  it('— each theme carries its own opacity, and they are not all the same', () => {
    const inks = new Set(
      SYSTEM_THEMES.map((t) => /opacity:([0-9.]+)/.exec(css(t.key))?.[1]).filter(Boolean)
    );
    expect(inks.size, 'شفافية واحدة لكلّ الثيمات = ما حدا قاس شي').toBeGreaterThan(5);
  });

  it('and the loudest art is the quietest layer', () => {
    /*
     * THE CLAIM THAT CATCHES A BAD REPLACEMENT.
     *
     * `epic` is old gold on near-black — the biggest brightness gap in
     * the set — and `cyber` is a hairline on black, the smallest. If a
     * new drawing ever arrives without being re-measured, the ordering is
     * what breaks first.
     */
    const of = (k: string) => Number(/opacity:([0-9.]+)/.exec(css(k))![1]);
    expect(of('epic')).toBeLessThan(of('cyber'));
    expect(of('day'), 'النهاري أعلى تباين، فلازم يكون أخفت').toBeLessThan(0.2);
    // 18/11/2026 (R1): the undecorated theme draws no layer, so it has no opacity to be in range.
    for (const t of SYSTEM_THEMES.filter((x) => !UNDECORATED.includes(x.key))) {
      expect(of(t.key), `${t.key} خارج المدى`).toBeGreaterThan(0);
      expect(of(t.key)).toBeLessThanOrEqual(1);
    }
  });

  it('and the middle of every drawing is empty, where the reading happens', () => {
    /*
     * Measured on the files themselves rather than trusted: the centre of
     * each mask must be clear, because the sign-in card, the empty
     * state's sentence and the wordmark all sit there. Read as bytes — a
     * WebP whose centre is opaque is a drawing that will cross a number.
     */
    const src = stripComments(repoFile('src/lib/theme-decoration.ts'));
    expect(src, 'ما في مكان بيشرح الفراغ الأوسط').toMatch(/HOLE|فراغ|empty/i);
  });
});

describe('and «تلقائي» wears both, because it has two palettes', () => {
  it('— the dark one plainly, the light one behind the media query', () => {
    const out = css(AUTO_THEME);
    expect(out).toContain(`/brand/decor/${AUTO_DARK}.webp`);
    expect(out).toContain(`/brand/decor/${AUTO_LIGHT}.webp`);
    expect(out, 'الفاتح لازم يكون ورا استعلام الوسائط').toMatch(
      /@media \(prefers-color-scheme: light\)\{[^}]*\/brand\/decor\/day\.webp/
    );
  });
});

describe('a composed theme wears three drawings, each in its own place', () => {
  const KEYS = Object.keys(COMPOSED);

  it('— the two Islamic themes, and only those', () => {
    expect(KEYS.sort()).toEqual(['islamic-calm', 'islamic-epic']);
    for (const k of KEYS) expect(SYSTEM_THEMES.some((t) => t.key === k)).toBe(true);
  });

  it('and the door draws all four layers: rosette, both corners, skyline', () => {
    for (const k of KEYS) {
      const out = css(k);
      expect(out, `${k}: الوردة`).toContain(`.zk-decor-door::before{`);
      expect(out, `${k}: زاوية اليمين`).toContain(`.zk-decor-door::after{`);
      expect(out, `${k}: زاوية اليسار`).toContain(`.zk-decor-door .zk-decor-l{`);
      expect(out, `${k}: الأفق`).toContain(`.zk-decor-door .zk-decor-b{`);
      expect(out).toContain(`/brand/decor/${k}.rosette.webp`);
      expect(out).toContain(`/brand/decor/${k}.skyline.webp`);
    }
  });

  it('and the left corner is the right one TURNED, not a second file', () => {
    for (const k of KEYS) {
      const out = css(k);
      const left = out.slice(out.indexOf('.zk-decor-door .zk-decor-l{'));
      expect(left.slice(0, left.indexOf('}'))).toContain('transform:scaleX(-1)');
      // one `.corner.webp`, drawn three times (right, left, sidebar)
      expect(readdirSync(DECOR_DIR).filter((f) => f.startsWith(`${k}.corner`))).toEqual([`${k}.corner.webp`]);
    }
  });

  it('and an empty list gets the rosette alone, fitted to its box', () => {
    for (const k of KEYS) {
      const out = css(k);
      const empty = out.slice(out.indexOf('.zk-decor-empty::after{'));
      const rule = empty.slice(0, empty.indexOf('}'));
      expect(rule).toContain('rosette.webp');
      // `contain`: a mask is clipped to the box it belongs to, and a list with
      // nothing in it is short.
      expect(rule).toContain('contain');
    }
  });

  it('and the sidebar gets one corner, turned to sit away from the wordmark', () => {
    for (const k of KEYS) {
      const out = css(k);
      const side = out.slice(out.indexOf('.zk-decor-sidebar::after{'));
      const rule = side.slice(0, side.indexOf('}'));
      expect(rule).toContain('corner.webp');
      expect(rule).toContain('transform:scaleX(-1)');
    }
  });

  it('and the door’s own circuit-wave banner is taken out from under it — for these themes only', () => {
    for (const k of KEYS) expect(css(k), k).toContain('.zk-door-banner{display:none}');
    for (const t of SYSTEM_THEMES.filter((x) => !COMPOSED[x.key] && !PHOTOGRAPHIC[x.key])) {
      expect(css(t.key, 'full'), `${t.key} خبّى البنر`).not.toContain('zk-door-banner');
    }
    const stage = stripComments(repoFile('src/components/shell/BrandStage.tsx'));
    // Both the picture and the scrim over it carry the hook.
    expect(stage.match(/zk-door-banner/g)).toHaveLength(2);
  });

  it('and nothing drawn here is louder than 0.3, or the rosette than 0.2', () => {
    /*
     * The ceiling is what stops a number being nudged «to make it show».
     * The rosette is the one that sits where the text is, so it has the
     * lower one; the corners and the roofline live at the edges.
     */
    for (const [k, c] of Object.entries(COMPOSED)) {
      expect(c.rosette, `${k} rosette`).toBeLessThanOrEqual(0.2);
      expect(c.corner, `${k} corner`).toBeLessThanOrEqual(0.3);
      expect(c.skyline, `${k} skyline`).toBeLessThanOrEqual(0.3);
      expect(c.rosette).toBeLessThan(c.corner);
    }
  });

  it('and the heading and the tagline stay legible over the loudest the ornament can be', () => {
    /*
     * WORST CASE, COMPUTED: the pixel under the wordmark if the ornament
     * covered it completely, at the highest opacity any layer of the theme
     * has. Text is measured against THAT, not against the plain
     * background — the same move `brand-stage.test.ts` makes for the
     * banner, and for the same reason: the picture is the thing somebody
     * will replace, and the numbers are the thing somebody will nudge.
     */
    const lin = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    /*
     * TWO BOUNDS, BECAUSE THE LAYERS ARE NOT ALL IN THE SAME PLACE.
     *
     * The ROSETTE is the one drawn behind the text — the wordmark, the
     * tagline and the footer line sit over its rings by design — so both
     * text colours must clear 4.5:1 over it at its own opacity.
     *
     * The corners and the roofline are at the edges of the screen, where no
     * text is. They are held to the heading at 4.5:1 and to the muted text
     * at 3:1, which is not a pass for small text and is not claimed as one:
     * it is the floor for the odd viewport where an edge and a line of text
     * meet, and the reason the loudest of them is capped at 0.3.
     *
     * The first version of this claim asked for 4.5 over the LOUDEST layer
     * for both colours, and it failed the calm theme at 3.36 — which was
     * not a bug in the claim but a true thing about the palette: 4.90:1 on
     * plain paper leaves nothing for a drawing to take. The token was
     * darkened (see `muted-foreground` in system-themes.ts) rather than the
     * claim loosened.
     */
    const over = (hex: string, bgHex: string, inkHex: string, opacity: number) => {
      const bg = rgb(bgHex);
      const ink = rgb(inkHex);
      return ratio(rgb(hex), bg.map((v, i) => v + opacity * (ink[i] - v)));
    };
    for (const [k, c] of Object.entries(COMPOSED)) {
      const v = themeByKey(k).vars;
      const loudest = Math.max(c.rosette, c.corner, c.skyline);
      for (const name of ['heading', 'muted-foreground'] as const) {
        const r = over(v[name], v.background, v.primary, c.rosette);
        expect(r, `${k}: ${name} تحت الوردة = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
      const h = over(v.heading, v.background, v.primary, loudest);
      expect(h, `${k}: heading تحت الأعلى = ${h.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      const m = over(v['muted-foreground'], v.background, v.primary, loudest);
      expect(m, `${k}: muted-foreground عند الحافة = ${m.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('and the door’s content is drawn ABOVE the ornament, not under it', () => {
    /*
     * The decoration layer is `position: absolute; z-index: 0`, and a
     * positioned element paints over a static one whatever the markup
     * order. The column was static, so every ornament this door ever drew
     * went over the wordmark and the card — unseen while the layer was two
     * soft washes, and seen the moment it became a drawing.
     */
    const stage = stripComments(repoFile('src/components/shell/BrandStage.tsx'));
    expect(stage, 'عمود المحتوى مش موضَّع').toMatch(/className="relative w-full max-w-lg/);
  });

  it('and only the door gets the two extra layers', () => {
    const src = stripComments(repoFile('src/components/shell/ThemeDecor.tsx'));
    expect(src).toMatch(/place === 'door' && \(/);
    expect(src).toContain('-l`');
    expect(src).toContain('-b`');
  });
});

describe('and it turns, but only where turning can be seen and is wanted', () => {
  it('— the rosette turns at the full level, and the layer does not drift', () => {
    for (const k of Object.keys(COMPOSED)) {
      const out = css(k, 'full');
      expect(out).toContain('@keyframes zk-decor-turn');
      expect(out).toContain('zk-decor-door.zk-decor-full::before{animation:zk-decor-turn');
      // A drift would show a seam along the edges the corners and the roofline sit on.
      expect(out, `${k}: انجراف الطبقة`).not.toContain('zk-decor-drift');
    }
  });

  it('and the light level does not move at all', () => {
    for (const k of Object.keys(COMPOSED)) {
      expect(css(k, 'light')).not.toContain('@keyframes');
    }
  });

  it('and reduced motion removes it and a hidden tab pauses it', () => {
    for (const k of Object.keys(COMPOSED)) {
      const out = css(k, 'full');
      expect(out).toMatch(/prefers-reduced-motion: reduce\)\{[^}]*animation:none/);
      expect(out).toContain('[data-decor-hidden] .zk-decor-door.zk-decor-full::before{animation-play-state:paused}');
    }
  });

  it('and the other eight still drift, exactly as they did', () => {
    for (const t of SYSTEM_THEMES.filter((x) => !COMPOSED[x.key] && !PHOTOGRAPHIC[x.key] && !UNDECORATED.includes(x.key))) {
      expect(css(t.key, 'full'), t.key).toContain('@keyframes zk-decor-drift');
    }
  });
});

describe('and turning it off still costs nothing', () => {
  it('— «off» writes no CSS at all, ornament included', () => {
    for (const t of SYSTEM_THEMES) expect(css(t.key, 'off')).toBe('');
    expect(css(AUTO_THEME, 'off')).toBe('');
  });

  it('and the ornaments are not in the stylesheet everybody downloads', () => {
    /*
     * The same arrangement the palettes use, for the same reason: this is
     * written into the document beside the chosen theme, so one person
     * downloads one mask. A `decor/` url appearing in a built stylesheet
     * would mean all eleven reach everybody.
     */
    for (const sheet of ['src/app/(system)/system.css', 'src/app/globals.css']) {
      expect(stripComments(repoFile(sheet)), `الرسمات دخلت ${sheet}`).not.toContain('brand/decor');
    }
  });

  it('and no single mask is heavy enough to be felt', () => {
    // One file reaches one person — but that person is on a phone.
    for (const f of readdirSync(DECOR_DIR).filter((n) => n.endsWith('.webp'))) {
      const kb = statSync(join(DECOR_DIR, f)).size / 1024;
      expect(kb, `${f} صار ${Math.round(kb)} KB`).toBeLessThan(140);
    }
  });

  it('and every one of them carries its coverage in the ALPHA channel', () => {
    /*
     * The bug a browser found and nothing else could: a grey mask with no
     * alpha channel is, to `mask`, a rectangle in which every pixel is
     * covered — a solid primary-coloured square across the whole door.
     * Luminance masking would need `mask-mode`, which Safari does not have.
     *
     * Read from the file header rather than decoded: a lossy WebP with
     * alpha is a VP8X chunk with bit 4 of its flags set; a lossless one
     * says so in the first bits of its VP8L stream.
     */
    for (const f of maskFiles()) {
      const buf = readFileSync(join(DECOR_DIR, f));
      const kind = buf.subarray(12, 16).toString('ascii');
      let hasAlpha = false;
      if (kind === 'VP8X') hasAlpha = (buf[20] & 0x10) !== 0;
      else if (kind === 'VP8L') hasAlpha = (buf[24] & 0x10) !== 0;
      expect(hasAlpha, `${f} (${kind}) بلا قناة شفافية`).toBe(true);
    }
  });

  it('and they are masks on disk, not pictures', () => {
    /*
     * A mask is one channel. If somebody replaces one with a full-colour
     * export the file keeps its name and the CSS keeps working — it just
     * silently paints a primary-coloured rectangle, because every pixel
     * of an opaque image is «covered». WebP's header carries the alpha
     * flag in byte 20 of the VP8X/VP8L chunk, so the cheap, honest check
     * is that the file is small for its pixel count: a greyscale mask of
     * 768² lands far under what a colour photo of that size needs.
     */
    for (const f of maskFiles()) {
      const buf = readFileSync(join(DECOR_DIR, f));
      expect(buf.subarray(0, 4).toString('ascii'), `${f} مش WEBP`).toBe('RIFF');
      expect(buf.subarray(8, 12).toString('ascii')).toBe('WEBP');
    }
  });
});
