import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * THE SPRITE IS THE PRODUCT'S OWN GLYPHS, RENDERED — NOT COPIED.
 *
 * The studio is plain JavaScript with no bundler, so it cannot import a
 * React icon package. A second icon set would mean the two products
 * disagree about what «delete» looks like, which is the thing this package
 * exists to prevent.
 *
 * So each symbol is rendered from the very component operations draws, and
 * this re-runs that build and fails if the file on disk differs. Path data
 * copied by hand is wrong in one corner and unnoticed for a year.
 */

const PKG = join(process.cwd(), 'packages', 'zaki-ui');

/**
 * THE CLAIM IS ABOUT CONTENT, AND THE TREE IS LEFT AS FOUND — see `zaki-ui-tokens.test.ts` for why (RV50): the build writes LF, a
 * Windows checkout has CRLF, and a byte comparison is then red on every such machine. The committed files are only read; the build writes elsewhere (RV38).
 */
const lf = (text: string) => text.replace(/\r\n/g, '\n');
const SVG = join(PKG, 'icons.svg');
const INDEX = join(PKG, 'icons.json');
/** The bytes as this file found them — taken when it loads, before any test has run. */
const ORIGINAL = [readFileSync(SVG), readFileSync(INDEX)];

afterAll(() => {
  expect(Buffer.compare(readFileSync(SVG), ORIGINAL[0]), 'icons.svg: a test left it changed').toBe(0);
  expect(Buffer.compare(readFileSync(INDEX), ORIGINAL[1]), 'icons.json: a test left it changed').toBe(0);
});

/**
 * THE BUILD WRITES INTO A FOLDER OF ITS OWN (RV38).
 *
 * This used to run the build over the committed `icons.svg` and put the old
 * bytes back afterwards. In between, the committed file was a half-written
 * thing that any other test reading it at that moment (the package test
 * builds `dist/` from it) could see — a test that failed once in a full run
 * and passed alone twice. Now the committed files are only READ, and the
 * build's output is compared with them.
 */
function regenerate() {
  const out = mkdtempSync(join(tmpdir(), 'zaki-ui-icons-'));
  try {
    execFileSync(process.execPath, [join(PKG, 'scripts', 'build-icons.mjs')], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: { ...process.env, ZAKI_UI_ICONS_OUT: out },
    });
    const svg = lf(readFileSync(SVG, 'utf8'));
    const index = lf(readFileSync(INDEX, 'utf8'));
    expect(lf(readFileSync(join(out, 'icons.svg'), 'utf8')), 'icons.svg: الملف المحفوظ غير الناتج عن البناء').toBe(svg);
    expect(lf(readFileSync(join(out, 'icons.json'), 'utf8')), 'icons.json: الملف المحفوظ غير الناتج عن البناء').toBe(index);
    return { svg, index: JSON.parse(index) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

describe('the icon sprite', () => {
  it('is generated, and re-running the build changes nothing', () => {
    const { svg, index } = regenerate();
    expect(svg.length).toBeGreaterThan(5000);
    expect(index.count).toBeGreaterThanOrEqual(40);
  });

  it('and leaves both files exactly as it found them — byte for byte, whatever the checkout’s line endings', () => {
    regenerate();
    expect(Buffer.compare(readFileSync(SVG), ORIGINAL[0]), 'icons.svg').toBe(0);
    expect(Buffer.compare(readFileSync(INDEX), ORIGINAL[1]), 'icons.json').toBe(0);
  });

  it('carries every icon the owner named, in its five groups', () => {
    const { index } = regenerate();
    const named: Record<string, string[]> = {
      state: ['check', 'close', 'error-warning', 'alert', 'information', 'loader', 'lock', 'lock-unlock'],
      nav: ['arrow-up', 'arrow-down', 'arrow-left', 'arrow-right', 'chevron-up', 'chevron-down', 'chevron-left', 'chevron-right', 'external-link', 'menu'],
      action: ['refresh', 'search', 'filter', 'settings', 'edit', 'delete', 'copy', 'download', 'upload', 'eye'],
      media: ['play', 'pause', 'stop', 'volume', 'mic', 'image', 'film', 'scissors', 'music'],
      subject: ['user', 'group', 'bar-chart', 'database', 'cloud', 'inbox', 'time', 'history', 'rocket'],
    };
    for (const [group, names] of Object.entries(named)) {
      const got = (index.groups[group] ?? []).map((i: { name: string }) => i.name);
      for (const n of names) expect(got, `${group}/${n}`).toContain(n);
    }
  });

  /**
   * AND NOTHING WAS INVENTED. An icon whose Remix name does not exist is
   * reported in `missing` and gets no symbol — a hand-drawn stand-in would
   * be the one glyph in the product that is nobody's design.
   */
  it('invents no glyph for a name the package does not have', () => {
    const { index } = regenerate();
    expect(index.missing).toEqual([]);
  });

  it('every symbol has a shape, a viewBox and a unique id', () => {
    const { svg } = regenerate();
    const symbols = [...svg.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)];
    expect(symbols.length).toBeGreaterThanOrEqual(40);
    const ids = new Set<string>();
    for (const [, id, viewBox, inner] of symbols) {
      expect(id.startsWith('zk-'), id).toBe(true);
      expect(viewBox, id).toBe('0 0 24 24');
      expect(inner.includes('<path'), `${id} بلا شكل`).toBe(true);
      expect(ids.has(id), `${id} مكرَّر`).toBe(false);
      ids.add(id);
    }
  });

  /**
   * ONE FILE FOR EVERY THEME. A symbol that painted a fixed colour would
   * need a second copy for the light palette, and the two would drift.
   */
  it('paints with currentColor, so one file serves every theme', () => {
    const { svg } = regenerate();
    expect(svg).toContain('fill="currentColor"');
    // No literal colour anywhere in the sprite.
    expect(svg, 'لونٌ مكتوبٌ داخل السبرايت').not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(svg).not.toMatch(/\b(?:rgb|hsl)a?\(/);
  });

  it('and says whose glyphs they are, in the file itself', () => {
    const { svg, index } = regenerate();
    expect(svg).toContain('@remixicon/react');
    expect(svg).toMatch(/Licence as the package declares it: .+\./);
    expect(index.licence).toBeTruthy();
    expect(index.fromVersion).toBeTruthy();
  });
});
