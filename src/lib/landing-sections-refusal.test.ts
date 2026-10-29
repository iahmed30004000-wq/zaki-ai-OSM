import { describe, expect, it } from 'vitest';
import { landingSectionsSchema } from './landing-sections';
import { sectionsRefusal } from './landing-sections-refusal';
import { repoFile, stripComments } from './guard-source';

/**
 * ط12 — A REFUSED SAVE NAMES THE FIELD.
 *
 * The editor's save answered every rejected page with «أقسام الصفحة غير صالحة», over a page of forty sections and
 * whichever field had gone past its limit. The first thing zod found is named now: the section as the seller sees it
 * (`SECTION_LABEL`), where it sits, the field, and the limit — in Arabic, never in zod's English.
 *
 * «اي قرار بعد الان اتخذو دون الرجوع الي» — decided: the section is named by its on-screen name («الواجهة» for the first
 * screen), not by an internal one.
 */

const hero = (headline: string, id = 'h1') => ({ id, type: 'hero', headline });
const refusal = (sections: unknown) => {
  const parsed = landingSectionsSchema.safeParse(sections);
  if (parsed.success) throw new Error('expected a refusal');
  return sectionsRefusal(parsed.error, sections);
};

describe('the sentence', () => {
  it('a headline of 130 characters names the section, its place, the field and the limit', () => {
    const said = refusal([{ id: 't', type: 'text', body: 'ok' }, hero('ع'.repeat(130))]);
    expect(said).toContain('الواجهة');
    expect(said).toContain('القسم 2');
    expect(said).toContain('العنوان');
    expect(said).toContain('120');
  });

  it('a field inside a list is named by its own name, under the section', () => {
    const said = refusal([{ id: 'b', type: 'benefits', items: [{ title: 'ok', text: 'س'.repeat(250) }] }]);
    expect(said).toContain('المميزات');
    expect(said).toContain('النص');
    expect(said).toContain('200');
  });

  it('never prints zod\'s English', () => {
    const said = refusal([{ id: 'a', type: 'announcement', text: 'x'.repeat(5000) }]);
    expect(said).not.toMatch(/Too big|expected|string/i);
    expect(said).toMatch(/[\u0600-\u06FF]/);
  });

  it('more sections than the page may hold says the count', () => {
    const said = refusal(Array.from({ length: 41 }, (_, i) => hero('ok', `h${i}`)));
    expect(said).toContain('40');
  });

  it('an unknown kind of section falls back to the general sentence, not a guess', () => {
    expect(refusal([{ id: 'z', type: 'nonsense' }])).toBe('أقسام الصفحة غير صالحة');
  });

  it('NEGATIVE: the digits are Latin, as every figure on screen is', () => {
    const said = refusal([hero('ع'.repeat(130))]);
    expect(said).not.toMatch(/[٠-٩]/);
  });
});

describe('the door uses it', () => {
  it('the save route answers with it, and keeps the general sentence only as the helper\'s fallback', () => {
    const route = stripComments(repoFile('src/app/api/landing-pages/[id]/content/route.ts'));
    expect(route).toContain('sectionsRefusal(sections.error, parsed.data.sections)');
    expect(route).not.toContain("{ error: 'أقسام الصفحة غير صالحة' }");
  });

  it('NEGATIVE: a sound page raises no refusal at all', () => {
    expect(landingSectionsSchema.safeParse([hero('عنوان قصير')]).success).toBe(true);
  });
});
