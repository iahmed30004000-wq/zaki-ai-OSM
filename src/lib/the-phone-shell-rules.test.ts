import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PHONE-SHELL RULES THAT LIVE IN A STYLESHEET, A MANIFEST OR A ONE-LINE
 * CLASS, WHERE NO RENDER CAN SEE THEM.
 *
 *   • A FIELD IS 16 PIXELS WHERE A FINGER TYPES. iOS Safari zooms the whole
 *     page into any input, select or textarea whose text is under 16px and
 *     does not zoom back out; every field here was 14px or 12px. One rule in
 *     `system.css` covers all of them — and it must be inside the block for
 *     a finger (`pointer: coarse`: an iPad zooms too, and a mouse does not
 *     need it) and OUTSIDE any cascade layer, because unlayered CSS outranks
 *     the utility layer and that is the only reason it beats `text-sm`
 *     without an `!` on a hundred fields.
 *
 *   • THE INSTALLED APP TURNS. The manifest said `portrait`, so the app on an
 *     Android home screen never rotated, and the wide tables (orders,
 *     statements) read better on their side.
 *
 *   • A NAME KEEPS A FLOOR on a row that wraps. `min-w-0` on a flex item with
 *     `flex-1` makes its basis zero, so it is never the item that wraps and
 *     the buttons beside it take the whole line (RV78).
 *
 * jsdom has no media queries and no cascade, so these read the text.
 * ═══════════════════════════════════════════════════════════════════════
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/** The body of the first `@media <query> { … }` block, braces counted. */
function mediaBlock(css: string, query: string): string | null {
  const at = css.indexOf(`@media (${query})`);
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  return null;
}

describe('a field is 16px where a finger types', () => {
  const sheet = () => stripComments(read('src/app/(system)/system.css'));

  it('input, select and textarea are 16px inside the block for a finger', () => {
    const block = mediaBlock(sheet(), 'pointer: coarse');
    expect(block, 'لا كتلة للمس').not.toBeNull();
    const rule = /(?:^|\})\s*input\s*,\s*select\s*,\s*textarea\s*\{([^}]*)\}/.exec(block!);
    expect(rule, 'لا قاعدة للحقول داخل كتلة اللمس').not.toBeNull();
    expect(rule![1]).toMatch(/font-size:\s*16px/);
  });

  it('and not on the desk: no field rule outside a media block resizes text', () => {
    const outside = sheet().replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
    expect(outside, 'قاعدة الحقول صارت للمكتب أيضاً').not.toMatch(/(?:^|\})\s*input\s*,\s*select\s*,\s*textarea\s*\{[^}]*font-size/);
  });

  it('and the sheet has no cascade layer, which is why the rule outranks the utilities', () => {
    expect(sheet(), 'الورقة دخلت طبقة — القاعدة ما عاد تتغلّب').not.toMatch(/@layer\b/);
  });
});

describe('the installed app', () => {
  it('may turn: the manifest does not pin it to portrait', () => {
    const manifest = JSON.parse(read('public/manifest.webmanifest'));
    expect(manifest.orientation, 'التطبيق المثبّت مقفل عامودياً').not.toBe('portrait');
    expect(manifest.orientation).toBe('any');
  });
});

describe('a name on a row that wraps', () => {
  it('the store’s name on the geography screen keeps a floor, so it is the item that wraps', () => {
    const src = stripComments(read('src/components/screens/GeoSettingsScreen.tsx'));
    expect(src).toMatch(/<div className="flex-1 min-w-\[150px\]">\s*<p[^>]*>\{s\.name\}<\/p>/);
  });
});
