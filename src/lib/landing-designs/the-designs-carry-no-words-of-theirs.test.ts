import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESIGN_IDS, DESIGN_LOADERS } from '@/components/landing/designs/generated/index';
import { SHELL_CSS } from '@/components/landing/designs/generated/shell';
import { designIdOf, designFontHref, isDesignId, loadDesign } from './load';
import type { DesignSkin } from './skin';

/**
 * «شيل الادعاءات المخترعة» — THE GENERATED DESIGNS HOLD NONE OF THEIR WORDS.
 *
 * Their default copy invents things: «+50K عميل سعيد», «ضمان استرداد 60
 * يوم», «سارة م. — مشترية موثقة» on reviews nobody wrote, and, on every one of
 * the sixty-four, sentences like «مفحوص قبل الشحن» that no shop of ours has
 * promised. A design here is a look; our blocks say what the page says, and
 * our reviews block (real ProductReview first) and our trust row (facts the
 * server measured) are the only places a claim may come from.
 *
 * So the files the generator writes are held to a stronger rule than «not
 * those strings»: they carry NO Arabic at all. A template has no field that
 * could hold a sentence, and this is what proves it stayed that way.
 */

const DIR = join(process.cwd(), 'src', 'components', 'landing', 'designs');
const files = (sub: string) =>
  readdirSync(join(DIR, sub))
    .filter((f) => /\.(ts|js)$/.test(f))
    .map((f) => ({ name: `${sub}/${f}`, text: readFileSync(join(DIR, sub, f), 'utf8') }));
const GENERATED = [...files('generated'), ...files('motion')];

/** The claims the owner's report found on his platform's default pages, and the copy every design shipped with. */
const INVENTED = [
  '+50K',
  '50K',
  'عميل سعيد',
  'ضمان استرداد',
  '60 يوم',
  'مشترية موثقة',
  'مشتري موثق',
  'سارة م',
  'مفحوص قبل الشحن',
  'جودة عالية',
  'كوزمتكس',
  'تسوق آمن',
  'إرجاع مجاني',
  'طلبات مفحوصة',
];

/** Any Arabic letter, outside the ASCII-only motion scripts and templates. */
const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

/** The test's own eyes, checked against something that SHOULD fail before they are trusted. */
function wordsIn(text: string): string[] {
  const hits = INVENTED.filter((w) => text.includes(w));
  if (ARABIC.test(text)) hits.push('حرف عربي');
  return hits;
}

describe('the generated designs carry none of their words', () => {
  it('finds every generated file it is meant to read', () => {
    // A guard reading an empty folder would pass forever.
    expect(GENERATED.length).toBeGreaterThanOrEqual(DESIGN_IDS.length + 2);
    for (const id of DESIGN_IDS) expect(GENERATED.some((f) => f.name === `generated/${id}.ts`), id).toBe(true);
  });

  it.each(GENERATED.map((f) => [f.name, f.text]))('%s holds no claim and no sentence', (_name, text) => {
    expect(wordsIn(text)).toEqual([]);
  });

  it('and the check itself catches a claim when there is one', () => {
    expect(wordsIn('{"x":"+50K عميل سعيد"}')).toContain('+50K');
    expect(wordsIn('{"x":"ضمان استرداد 60 يوم"}')).toContain('ضمان استرداد');
    expect(wordsIn('{"x":"نص"}')).toContain('حرف عربي');
    expect(wordsIn('{"x":"#e11d48"}')).toEqual([]);
  });

  it('and their product photograph is not in any of them — a design draws OUR product', () => {
    for (const f of GENERATED) expect(f.text, f.name).not.toMatch(/\/web\/media|\.jpe?g|\.png|\.webp/i);
  });
});

/** Every selector of a stylesheet, outside @keyframes. */
function selectors(css: string): string[] {
  const out: string[] = [];
  const walk = (s: string) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      if (open < 0) break;
      const head = s.slice(i, open).trim();
      let depth = 1;
      let k = open + 1;
      while (k < s.length && depth) {
        if (s[k] === '{') depth++;
        else if (s[k] === '}') depth--;
        k++;
      }
      const body = s.slice(open + 1, k - 1);
      if (head.startsWith('@media') || head.startsWith('@supports')) walk(body);
      else if (!head.startsWith('@')) out.push(...head.split(/,(?![^(]*\))/).map((x) => x.trim()));
      i = k;
    }
  };
  walk(css);
  return out;
}

const unscoped = (css: string) => selectors(css).filter((sel) => !sel.includes('[data-design]'));

describe('a design styles nothing outside the page that wears it', () => {
  it('every rule of every design is under [data-design]', async () => {
    for (const id of DESIGN_IDS) {
      const skin = (await DESIGN_LOADERS[id]()).default;
      expect(unscoped(skin.css), id).toEqual([]);
    }
    expect(unscoped(SHELL_CSS)).toEqual([]);
  });

  it('and the check catches a rule that escapes', () => {
    expect(unscoped('[data-design] .a{x:1}.b{y:2}@media (max-width:1px){.c{z:3}}')).toEqual(['.b', '.c']);
  });

  it('and fetches nothing from anywhere — no @import, no outside url()', async () => {
    for (const id of DESIGN_IDS) {
      const { css } = (await DESIGN_LOADERS[id]()).default;
      expect(css, id).not.toMatch(/@import/);
      // A url() may only be an inline picture, or a reference inside one (an svg filter's own `url(#n)`).
      expect(css.match(/url\(\s*(?!["']?(?:data:|%23|#))[^)]*\)/g) ?? [], id).toEqual([]);
    }
  });

  it('and its typeface comes from the one font host every page already uses', async () => {
    for (const id of DESIGN_IDS) {
      const skin = (await DESIGN_LOADERS[id]()).default;
      const href = designFontHref(skin);
      expect(href, id).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=[A-Za-z0-9+:;@,.]+&display=swap$/);
    }
    // and a font spec that is not one is not put in a URL
    expect(designFontHref({ font: { family: 'x', google: 'x"><script>' } } as Pick<DesignSkin, 'font'>)).toBeNull();
  });
});

describe('a page names its design in its theme', () => {
  it('reads the id from the stored theme JSON, or from a parsed theme', () => {
    expect(designIdOf(JSON.stringify({ accent: '#e11d48', design: DESIGN_IDS[0] }))).toBe(DESIGN_IDS[0]);
    expect(designIdOf({ design: DESIGN_IDS[0] })).toBe(DESIGN_IDS[0]);
  });

  it('and reads no design — not a fallback — for anything else', () => {
    expect(designIdOf(null)).toBeNull();
    expect(designIdOf('')).toBeNull();
    expect(designIdOf('{not json')).toBeNull();
    expect(designIdOf(JSON.stringify({ accent: '#e11d48' }))).toBeNull();
    expect(designIdOf({ design: 'no-such-design' })).toBeNull();
    expect(designIdOf({ design: '<script>' })).toBeNull();
    expect(designIdOf({ design: 7 })).toBeNull();
    expect(isDesignId('__proto__')).toBe(false);
  });

  it('loads the design it names, and nothing for a name it does not know', async () => {
    const skin = await loadDesign(DESIGN_IDS[0]);
    expect(skin?.id).toBe(DESIGN_IDS[0]);
    expect(await loadDesign('no-such-design')).toBeNull();
    expect(await loadDesign(null)).toBeNull();
  });

  it('every generated design is the id it is filed under, with sections to draw', async () => {
    for (const id of DESIGN_IDS) {
      const skin = (await DESIGN_LOADERS[id]()).default;
      expect(skin.id).toBe(id);
      expect(skin.sections.some((s) => s.role === 'hero'), id).toBe(true);
      expect(skin.animated, id).toBe(id.startsWith('imx-'));
    }
  });
});
