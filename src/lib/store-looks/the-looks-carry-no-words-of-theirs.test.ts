import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME_DESIGNS, designSections } from './index';
import { LOOK_NAMES, DESIGN_NAMES } from './names.generated';

/**
 * «شيل الادعاءات المخترعة» — NOTHING OF THEIR COPY REACHES A SHOP.
 *
 * Their home designs ship with sentences («ستايل ما بيقدم لكل يوم»,
 * «وفّر لحد 15%», «توصيل سريع»), a countdown to a date somebody typed,
 * their product photographs and their category names («كوزمتكس»). A look
 * here is tokens and a design is a list of OUR block types; the files the
 * generator writes for them hold no Arabic letter at all, so no field of
 * theirs could carry a sentence. The one file that does hold Arabic is the
 * SELLER's gallery's names, and it is checked for claims too.
 */

const DIR = __dirname;
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');
const DATA = ['ids.generated.ts', 'tokens.generated.ts', 'designs.generated.ts'].map((f) => [f, read(f)] as const);

/** Their copy, from the harvest of 3/11 — none of it may ever be on our page. */
const THEIRS = [
  '+50K', 'عميل سعيد', 'ستايل ما بيقدم لكل يوم', 'تسوّق كل المنتجات', 'طبقات خفيفة لكل يوم', 'توصيل سريع',
  'عروض ميجا بلّشت', 'وفّر لحد 15%', 'كوزمتكس', 'Category One', 'اختيارات فريقنا', 'قد تعجبك أيضا',
  'العرض ينتهي خلال', 'خصم يصل إلى 50%', 'تخفيضات الصيف', 'كن أول من يعرف', 'منأكد بالتلفون', 'جودة بتبيّن',
];

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

function wordsIn(text: string): string[] {
  const hits = THEIRS.filter((w) => text.includes(w));
  if (ARABIC.test(text)) hits.push('حرف عربي');
  return hits;
}

describe('the generated looks and designs carry none of their words', () => {
  it.each(DATA)('%s holds no claim and no sentence', (_f, text) => {
    expect(wordsIn(text)).toEqual([]);
  });

  it('and no photograph or product of theirs', () => {
    for (const [f, text] of DATA) expect(text, f).not.toMatch(/\/web\/|\.jpe?g|\.png|\.webp|productId|categoryId/i);
  });

  it('and the check itself catches a sentence when there is one', () => {
    expect(wordsIn('{"x":"توصيل سريع"}')).toContain('توصيل سريع');
    expect(wordsIn('{"x":"نص"}')).toContain('حرف عربي');
    expect(wordsIn('{"x":"#e11d48"}')).toEqual([]);
  });

  it('the page a design installs says none of it either', () => {
    for (const d of HOME_DESIGNS) {
      const text = JSON.stringify(designSections(d));
      expect(THEIRS.filter((w) => text.includes(w)), d.id).toEqual([]);
      expect(text, d.id).not.toMatch(/\/web\//);
    }
  });

  it('the seller’s gallery names are names and lines, and claim nothing of theirs', () => {
    const names = JSON.stringify({ LOOK_NAMES, DESIGN_NAMES });
    expect(THEIRS.filter((w) => names.includes(w))).toEqual([]);
    // The three lines that promised parts of THEIR storefront were cut at that clause.
    expect(LOOK_NAMES.souq.line).not.toContain('عدد المبيعات');
    expect(LOOK_NAMES.atelier.line).not.toContain('فيديو');
    expect(LOOK_NAMES.studio.line).not.toContain('عناوين أقسام');
  });

  it('and no shopper page imports the names file', () => {
    for (const rel of [
      '../../components/storefront/StorefrontShell.tsx',
      '../../components/storefront/extras-sheet.ts',
      '../../app/s/[store]/page.tsx',
      '../../components/landing/blocks/PageBlocks.tsx',
    ]) {
      expect(read(rel), rel).not.toContain('names.generated');
    }
  });
});
