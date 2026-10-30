import { describe, expect, it } from 'vitest';
import { dashboardFiles, stripComments, themeExempt } from './guard-source';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CHART_SERIES, SYSTEM_THEMES } from './system-themes';

/**
 * THE GATES, CHECKED RATHER THAN CLAIMED.
 *
 * Most of the redesign's promises already have a guard of their own, next
 * to the thing they guard — contrast beside the palette, mirroring beside
 * the icons, the press beside the button. This file holds the ones that
 * had nowhere else to live, and the ones nobody had written at all.
 *
 * What it deliberately does NOT do is restate a gate another file already
 * enforces. A promise checked in two places is a promise that gets edited
 * in one of them.
 */

const css = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

/**
 * ARABIC IS NOT LATIN, AND THE TWO RULES THAT BREAK IT.
 *
 * `letter-spacing` pulls a joined script apart — the letters of a word
 * stop touching, and an Arabic word whose letters do not touch is a word
 * the eye has to assemble. `text-transform` has no meaning at all in a
 * script with no cases, and `uppercase` on Arabic is a rule that does
 * nothing except catch the Latin caught up in it.
 */
describe('Arabic text', () => {
  it('is never spaced out or case-transformed', () => {
    const sheet = css('src/app/(system)/system.css');
    // The blanket guard, in one place, so no screen has to remember.
    expect(sheet, 'لا قاعدة تحمي الحرف العربيّ من التباعد').toMatch(
      /\[lang=["']?ar|:lang\(ar\)|\*\s*\{[^}]*letter-spacing:\s*0\s*!important/
    );
    expect(sheet).toContain('letter-spacing: 0 !important');
    expect(sheet).toContain('text-transform: none !important');
  });

  it('and no screen re-applies either to Arabic of its own', () => {
    const offenders: string[] = [];
    for (const { rel, src } of dashboardFiles()) {
      for (const [i, line] of stripComments(src).split('\n').entries()) {
        if (!/[\u0600-\u06FF]/.test(line)) continue;
        if (/\btracking-(?:tighter|tight|wide|wider|widest|\[)/.test(line) || /\buppercase\b|\bcapitalize\b/.test(line)) {
          offenders.push(`${rel}:${i + 1}`);
        }
      }
    }
    expect(offenders, `تباعدٌ أو تحويلُ حالةٍ على نصٍّ عربيّ:\n${offenders.slice(0, 15).join('\n')}`).toEqual([]);
  });
});

/**
 * A CHART'S COLOURS MEAN «ANOTHER SERIES», NOT «SOMETHING IS WRONG».
 *
 * Red means money lost and green means collected, everywhere in this
 * product. A chart that draws its third line in the red reserved for a
 * loss has told the reader something it did not intend, and the reader
 * believes it — semantic colour is learned, and it is learned once.
 */
describe('a chart series', () => {
  it('never borrows a semantic hue', () => {
    const clash: string[] = [];
    for (const theme of SYSTEM_THEMES) {
      const semantic = new Set(
        ['destructive', 'success', 'warning'].map((k) => theme.vars[k].toLowerCase())
      );
      for (const key of CHART_SERIES) {
        if (semantic.has(theme.vars[key].toLowerCase())) clash.push(`${theme.key}: ${key}`);
      }
    }
    expect(clash, `لونُ مخطّطٍ يحمل معنًى دلاليّاً: ${clash.join('، ')}`).toEqual([]);
  });

  it('and every theme defines the whole series', () => {
    for (const theme of SYSTEM_THEMES) {
      for (const key of CHART_SERIES) {
        expect(theme.vars[key], `${theme.key}: ${key} مفقود`).toBeTruthy();
      }
    }
  });
});

/**
 * THE BRAND SHOWS ITSELF ONCE, ON THE WAY IN.
 *
 * The banner, the gradient and the mark belong to sign-in and the pickers
 * — the three moments where nothing is being measured. On a data screen
 * they are decoration competing with a number somebody is reading.
 */
describe('brand imagery', () => {
  it('appears on the entry screens and nowhere else', () => {
    const offenders: string[] = [];
    for (const { rel, src } of dashboardFiles()) {
      // The way IN: sign-in, register, the two password screens, and the
      // country/store pickers. Plus the frame that names the app's own
      // icon for an installed tab, and the sidebar's 44px lockup — a mark,
      // not imagery.
      const ENTRY = /(?:login|register|forgot-password|reset-password|pending)\/page\.tsx$|BrandStage|EntryPicker|Sidebar\.tsx$|\(system\)\/layout\.tsx$/;
      if (ENTRY.test(rel)) continue;
      const body = stripComments(src);
      if (body.includes('/brand/banner')) offenders.push(`${rel}: البانر`);
      // `logo.svg` was the placeholder, and it is gone: the mark is now
      // `/brand/mark.png`, lifted from the supplied lockup. A guard still
      // watching the old filename would pass on every screen for the
      // reason that no screen can use it — which is not a guard.
      if (/brand\/mark\.png/.test(body)) offenders.push(`${rel}: العلامة`);
    }
    expect(offenders, `صورةُ علامةٍ على شاشة بيانات:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('and the installed app uses the same mark', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'public/manifest.webmanifest'), 'utf8'));
    expect(manifest.icons?.length, 'لا أيقونةَ للتطبيق المثبَّت').toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      expect(existsSync(join(process.cwd(), 'public', icon.src.replace(/^\//, ''))), `${icon.src} مفقود`).toBe(true);
    }
  });
});

/**
 * A PRESS ANSWERS WITHIN 80 MILLISECONDS.
 *
 * Not 150, which is where this started: at 150ms the control is still
 * moving when the finger has already left it, and «did that register» is
 * exactly the question a second press answers.
 */
describe('the press', () => {
  it('starts and finishes inside 80ms', () => {
    const sheet = stripComments(css('src/app/(system)/system.css'));
    const m = /transition:\s*transform\s+(\d+)ms/.exec(sheet);
    expect(m, 'لا انتقال على الضغط').toBeTruthy();
    expect(Number(m![1]), 'الاستجابة أبطأ من أن تُحسّ كضغطة').toBeLessThanOrEqual(80);
  });
});

/**
 * WHOEVER LOCKS THE PAGE'S SCROLL PUTS IT BACK AS THEY FOUND IT.
 *
 * Two components take this lock — the dialog and the phone's drawer. The
 * drawer always saved the previous value and restored it; the dialog wrote
 * `'unset'`, which is not «what it was» but «scrollable». So a dialog opened
 * and closed above an open drawer handed the page its scroll back underneath
 * it.
 *
 * A literal is always wrong here, because the writer cannot know whether
 * somebody else is already holding the lock.
 */
describe('a scroll lock', () => {
  it('restores the value it found, wherever one is taken', () => {
    const offenders: string[] = [];
    for (const { rel, src } of dashboardFiles()) {
      const body = stripComments(src);
      if (!/body\.style\.overflow\s*=\s*'hidden'/.test(body)) continue;
      if (!/const \w+ = document\.body\.style\.overflow/.test(body)) {
        offenders.push(`${rel}: يقفل التمرير ولا يقرأ قيمته أوّلاً`);
      }
      const literal = /body\.style\.overflow\s*=\s*'(?:unset|auto|visible|scroll|)'/.exec(body);
      if (literal) offenders.push(`${rel}: يُعيد التمرير إلى ${literal[1] || "''"} لا إلى ما وجده`);
    }
    expect(offenders, `قفلُ تمريرٍ لا يُعاد كما كان:\n${offenders.join('\n')}`).toEqual([]);
  });
});

/**
 * ONE COMPONENT LIBRARY.
 */
describe('the component library', () => {
  it('is this one — no second kit, and no ripple to suppress', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const kit of ['@mui/material', '@mui/base', 'antd', 'react-bootstrap', '@chakra-ui/react']) {
      expect(deps, `${kit}: مكتبة مكوّنات ثانية`).not.toContain(kit);
    }
  });
});

/**
 * NO HARDCODED SPACING OR FONT SIZE OUTSIDE THE TOKENS.
 *
 * Tailwind's own scale IS the spacing token set — `p-4` is a token, and
 * forbidding it would forbid the design system. What this refuses is the
 * arbitrary value: a padding of 13px, a font of 15px, a gap of 7px written
 * in brackets: a number somebody measured once, which no other screen will
 * ever match.
 */
describe('spacing and type', () => {
  const ALLOWED = [
    // Layout maths that is not a spacing choice: a viewport fraction, a
    // safe-area inset, a variable, a percentage, a fixed panel width.
    /^\d+(\.\d+)?(vh|vw|dvh|svh)$/,
    /^calc\(/,
    /^var\(/,
    /^env\(/,
    /^\d+%$/,
    /^min\(|^max\(/,
    // A colour written into a `text-[…]`. It is a palette question, and
    // `one-palette` asks it — including which third-party brands are
    // allowed to keep their own.
    /^#[0-9a-fA-F]{3,8}$/,
  ];

  it('use the scale, never a number somebody measured once', () => {
    const offenders: string[] = [];
    // Space and type size only. Colour has `one-palette`, and
    // letter-spacing has the Arabic rule above — a Latin wordmark is
    // allowed to be tracked out, and an Arabic word never is.
    const PROP = /(?<![\w-])(?:p|px|py|pt|pb|ps|pe|m|mx|my|mt|mb|ms|me|gap|gap-x|gap-y|space-x|space-y|text|leading)-\[([^\]]+)\]/g;
    for (const { rel, src } of dashboardFiles()) {
      // The page editor keeps its own type sizes — 43 of them, off the
      // scale, and bringing them onto it is a restyle. See `THEME_EXEMPT`.
      if (themeExempt(rel)) continue;
      for (const [i, line] of stripComments(src).split('\n').entries()) {
        for (const m of line.matchAll(PROP)) {
          const v = m[1];
          if (ALLOWED.some((rx) => rx.test(v))) continue;
          offenders.push(`${rel}:${i + 1}  ${m[0]}`);
        }
      }
    }
    expect(offenders, `قياسٌ خارج السلّم:\n${offenders.slice(0, 25).join('\n')}`).toEqual([]);
  });
});

/**
 * AND WHAT THE BROWSER DOWNLOADS.
 *
 * Measured from the build, not asserted from memory.
 *
 * CSS is met with room: 98.5 KB raw, 16.4 KB gzipped, against 100.
 *
 * ICONS MISS, BY 2.7 KB, AND THE NUMBER TOOK THREE TRIES TO GET RIGHT.
 * The first measurement summed every icon definition in the product —
 * 36 KB — which answers «how many concepts does this draw», not «what
 * does a browser fetch». The second guessed that per-route splitting
 * would save most of it. It does not: the bundler puts 231 of the icon
 * paths in ONE shared chunk, so nearly every page pays nearly all of it.
 * The shipped figure is 32.7 KB gzipped of path data against a 30 KB
 * target.
 *
 * Closing it by drawing fewer things was examined and refused. 65 icons
 * are drawn in a single place, and reading them one by one they are not
 * duplicates — the hamburger, the filter funnel, the fullscreen pair,
 * cash against a bank card, three arrows pointing three ways. Deleting
 * distinctions to save 8% is the kind of tidiness that costs meaning.
 *
 * What is guarded instead, in `icon-inventory.test.ts`: nothing is
 * imported and never drawn, and a fill is only ever an active state. Both
 * found something. The remaining 2.7 KB is a delivery question — a sprite
 * would move the paths out of JavaScript — and that is an architecture
 * change across 239 call sites, not a cleanup.
 */
describe('the payload', () => {
  /**
   * A RATCHET AT THE MEASURED SIZE, AND NOT THE ROUND NUMBER ANY MORE.
   *
   * This asserted «under 100 KB» and the comment above records 98.5 KB when
   * it was written. MEASURED 2026-10-11, the first time a production build
   * existed in the tree for this assertion to read: **102.58 KB**. The gate
   * only runs when `.next/static` is present, so the four kilobytes it grew
   * were invisible for as long as nobody built before running the suite —
   * which is the real defect here, and it is why this now pins the number.
   *
   * WHAT THE 102.58 IS, measured rather than guessed:
   *
   *   85.8 KB — Tailwind's generated utilities, 1245 rules. This is what
   *   the screens actually use; it grows with the product and shrinking it
   *   means using fewer distinct utilities, not configuring anything.
   *
   *   16.8 KB — `system.css`, which ships FOUR palettes in the first load:
   *   `ops`, `day`, `calm` and `auto`. One is active for any given reader
   *   and the other three are dead weight — about 4.2 KB each.
   *
   * SO THE BUDGET IS REACHABLE, and the route to it is named: move the
   * non-default palettes out of the first-load sheet and attach the chosen
   * one. That is a build change with a real risk of a flash of the wrong
   * theme, so it is a job of its own and not a line in a guard.
   *
   * Until then this is a RATCHET: the number cannot grow. A screen that
   * adds a new utility combination fails here, which is the whole point —
   * and it is already proved to work, because the screen added on the day
   * this was written (`BenchScreen`) moved it by ZERO, measured before and
   * after, by reusing utilities the product already had.
   *
   * ── 102.6 → 102.61, AND WHERE THE 5 BYTES CAME FROM ──
   *
   * Stage 1 (PR #3) landed 105,067 bytes, which is 102.6045 KB — four and
   * a half bytes past a ratchet set at 102.6. Measured on `main` itself,
   * with `.next/static` deleted first so no stale chunk could be counted:
   * `main` fails this, and the branch that found it moved the number by
   * ZERO (every utility its new control uses was already in the sheet).
   *
   * The ratchet is therefore re-pegged to the truth rather than to a
   * number nothing has satisfied since that merge — a red guard nobody can
   * make green stops being read.
   *
   * ── IT USED NOT TO FIRE IN CI AT ALL ──
   *
   * The tests run BEFORE the build, so `.next/static` did not exist and
   * the `existsSync` check below returned early: this measured nothing on
   * every pull request and every push, which is how a ratchet was crossed
   * without anybody seeing it. A guard that is silent when it cannot
   * measure is indistinguishable from a guard that passed.
   *
   * The order stays — «fails cheapest first» is right, and nobody should
   * wait through a production build to be told about a typo. Instead
   * `.github/workflows/ci.yml` runs this one file AGAIN after the build,
   * with `REQUIRE_BUILD=1`, and that flag turns the early return into a
   * FAILURE: under it, «there is no build to measure» is itself the bug.
   * Locally, with no flag, it still skips — nobody is made to build
   * before running the suite.
   */
  /*
   * ── 102.61 → 96.03, AND THE 6.5 KB CAME FROM THE FONTS ──
   *
   * A ratchet that only ever holds is half a ratchet: when the sheet
   * SHRINKS, the slack has to be taken away or the next screen spends it
   * without anybody choosing to.
   *
   * `src/app/(system)/fonts.ts` moved from `next/font/google` to
   * `next/font/local`. Google's loader writes an `@font-face` block per
   * script per weight with a `unicode-range` on each — and it was writing
   * them for cyrillic, cyrillic-ext, latin-ext and vietnamese, which no
   * screen in this product renders. Measured on a clean build, with
   * `.next-verify` deleted first:
   *
   *     before   105,028 bytes   102.566 KB   19 woff2 files
   *     after     98,329 bytes    96.024 KB   10 woff2 files
   *
   * Nine font files and 6.5 KB of stylesheet, for subsets nobody reads.
   * The number below is the measurement, not a round figure, and it is
   * re-pegged the same way it was last time: to the truth.
   */
  /*
   * ── 96.03 → 96.13, AND THE 101 BYTES BOUGHT «قاعدة الاحتساب» ──
   *
   * Every indicator card now states how its figure is worked out, behind
   * a `<details>` the person can open on a phone — the owner's rule for
   * every indicator, and not decoration: «نسبة التأكيد ٩٧٪» means one
   * thing out of the orders that were DECIDED and another out of every
   * order created, and the second falls whenever intake speeds up.
   *
   * A disclosure brings the platform's own marker with it — a triangle in
   * Chrome, a disc in Safari, on the wrong side in RTL — so it is hidden
   * in the element defaults in `system.css`. The first version used
   * `list-none` and `group` as utilities instead: both were used nowhere
   * else in the product, measured +32 bytes, and this ratchet caught
   * them. Two CSS rules in the defaults cost 101 bytes once and apply to
   * every disclosure this product ever draws, rather than per element.
   *
   * Measured on a clean build:  98,329 → 98,430 bytes.
   *
   * The number is the measurement, not a round figure, and it is re-pegged
   * the same way it was the last two times: to the truth. Growth here is
   * meant to be DELIBERATE and recorded — which this is — not impossible.
   */
  /*
   * ── 96.13 → 93.90, AND EIGHT NEW THEMES WENT IN AT THE SAME TIME ──
   *
   * The owner asked for eight more palettes. Eleven palettes in this file
   * is about ten kilobytes of colours that nine people in ten never see —
   * and the failure message below has said all along that the way down is
   * «فصلُ لوحاتِ الألوانِ غيرِ المختارة». So that is what was done
   * instead of re-pegging upward:
   *
   *   `system.css` keeps the DEFAULT — under `:root` as well, so a page
   *   rendered outside the system layout still has colours — and
   *   «تلقائي», which has to be answered by a media query or a phone in
   *   night mode is shown a white screen at four in the morning.
   *
   *   Every other palette is written into the document by `SystemFrame`,
   *   one rule for the one theme that person chose, in the same HTML
   *   response. The first paint is still right: no script, no flash.
   *
   * Measured on a clean build, eleven palettes in the product:
   *
   *     before (3 palettes)   98,430 bytes   96.123 KB
   *     after  (11 palettes)  96,151 bytes   93.897 KB
   *
   * Two palettes left the sheet and eight never entered it, so a twelfth
   * theme now costs the eleventh's bytes — which is nothing. See
   * `SHEET_THEMES` and `themeStyle` in src/lib/system-themes.ts.
   *
   * ── AND 132 BYTES WENT BACK ON, IN THE SAME BRANCH ──
   *
   * The settings control that chooses the decoration level, and the three
   * places the ambient layer is anchored, are ordinary markup and bring
   * ordinary utilities with them: 96,151 → 96,286 bytes.
   *
   * It is recorded rather than hidden, because that is the whole point of
   * this gate — growth here is meant to be DELIBERATE and written down,
   * not impossible. The branch's own arithmetic:
   *
   *     before the eight themes   98,430 bytes   96.123 KB
   *     palettes out of the sheet 96,151 bytes   93.897 KB   (−2,279)
   *     the decoration control    96,286 bytes   94.029 KB   (+135)
   *     ───────────────────────────────────────────────────
   *     net                                      −2.09 KB, with eight
   *                                              more themes in the product
   *
   * And the themes' own weight — eleven palettes, eleven card shapes, the
   * ambient CSS — is still none of it: all of that is written into the
   * document for the one theme that person chose.
   */
  /*
   * ⚠️ 94.04 and not 94.03: the measurement is 96,288 bytes, which is
   * 94.03125 KB — and `94.03` is BELOW it. The same two bytes read 96,286
   * on this machine, because the working tree is CRLF and the build on CI
   * is LF. The cap is stated above the measurement, never at a figure the
   * build has to round down to meet.
   */
  const CSS_BUDGET_KB = 94.04;

  it(`keeps the first-load stylesheet at or under ${CSS_BUDGET_KB} KB`, () => {
    /*
     * MEASURED WHEREVER THE BUILD WAS WRITTEN.
     *
     * This read `.next/static` outright, and `next dev` writes there too —
     * so running the suite beside a dev server measured the DEV sheet and
     * reported it as the production one. `next.config.ts` exists partly
     * for this: `NEXT_DIST_DIR` builds elsewhere precisely so these
     * budgets can be measured without stopping the server somebody is
     * working against. Honouring it here is what makes that possible.
     *
     * CI sets nothing, so it reads `.next` exactly as before.
     */
    const dir = join(process.cwd(), process.env.NEXT_DIST_DIR || '.next', 'static');
    /*
     * WHY THE FLAG IS CHECKED AND NOT JUST THE DIRECTORY.
     *
     * `existsSync` alone cannot tell «no build here, that is fine» from
     * «the build step did not produce one, which is the thing to shout
     * about». The caller knows which it is, and says so.
     */
    const required = process.env.REQUIRE_BUILD === '1';
    if (!existsSync(dir)) {
      if (required) {
        throw new Error(
          'لا يوجد بناءٌ لقياسِه: مجلّد `.next/static` غائب و`REQUIRE_BUILD=1` مطلوبٌ هنا. ' +
            'هذه الخطوة تَجري بعدَ «Build» في ci.yml عن قصد: إن لم يُنتِجِ البناءُ ' +
            'شيئاً فالسقفُ لم يُقَس — وحارسٌ صامتٌ لأنّه لم يَقِس لا يُفرَّقُ عن حارسٍ نجح.'
        );
      }
      return; // a local run with no build: nothing to measure, and that is fine
    }
    let bytes = 0;
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.css')) bytes += statSync(p).size;
      }
    };
    walk(dir);

    /*
     * PRINTED, NOT ONLY ASSERTED.
     *
     * A ratchet is a number somebody has to move on purpose one day. The
     * log line is how they learn how much room is left WITHOUT breaking
     * the build first — and how the four-and-a-half-byte overshoot that
     * started all this would have been visible the day it landed.
     */
    const kb = bytes / 1024;
    console.log(
      `[payload] أوراقُ الأنماطِ في أوّلِ تحميل: ${kb.toFixed(3)} ك.ب ` +
        `(${bytes} بايت) — السقف ${CSS_BUDGET_KB} ك.ب، المتبقّي ${(CSS_BUDGET_KB - kb).toFixed(3)} ك.ب`
    );

    expect(
      kb,
      `ورقةُ الأنماط كبرت — السقف ${CSS_BUDGET_KB} ك.ب وهو مقياسٌ لا رقمٌ مستدير. ` +
        'اقرأ التعليق أعلاه: الطريقُ للنزول هو فصلُ لوحاتِ الألوانِ غيرِ المختارة.'
    ).toBeLessThanOrEqual(CSS_BUDGET_KB);
  });
});
