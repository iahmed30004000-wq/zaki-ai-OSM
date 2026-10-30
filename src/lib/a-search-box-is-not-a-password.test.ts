import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripComments } from './guard-source';
import { typed } from './text-search';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SEARCH BOX IS NOT A PASSWORD FIELD.
 *
 * «ما بطلع بحث في المرتجعات». MEASURED on the live database before a line
 * was written: the waybill `GPMAINMUR6E5FO` is found by
 * `GPMAINMUR6E5FO` — one row — and by `gpmainmur6e5fo` — ZERO. The order
 * number too: `ord-2026-0039` finds nothing at all.
 *
 * Prisma's `contains` is `LIKE`, and Postgres applies `LIKE` with case. So
 * every search box in the product demanded that the person at the keyboard
 * reproduce the capitals of a code printed on a label, and told them «لا
 * نتائج» when they did not. The owner reported it against the returns
 * screen; it was twenty-eight lines in eight files.
 *
 * ── THIS SWEEP WALKS, IT DOES NOT LIST ──
 *
 * A guard that enumerates the files it knows about is complete on the day
 * it is written and wrong on the next commit. This reads `src` and finds
 * every `contains:` that exists, so the twenty-ninth search box somebody
 * adds next month is covered before it is written.
 *
 * Exemptions are NAMED, with the reason, and the sweep fails if an
 * exemption stops being needed — a list of excuses nobody prunes is how a
 * sweep quietly stops sweeping.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const ROOT = join(process.cwd(), 'src');

/**
 * THE ONE PLACE A CASE-SENSITIVE `contains` IS RIGHT, and why.
 *
 * Keyed by repo-relative path. The value is the reason, read by a person
 * deciding whether to add a second entry — the bar is «the needle is not
 * something a person typed».
 */
const EXEMPT: Record<string, string> = {
  'lib/superseded.ts':
    'يَبحثُ عن علامتَين ثابتتَين كتبتْهما أبوابُنا في نصِّ JSON لنشاطِ الطلب ("mode":"REPLACE" و"role":"REPLACEMENT") — الإبرةُ ثابتةٌ من عندنا لا من إنسان، والمطابقةُ الحرفيةُ هي المقصود',
  'lib/v1/order-origin.ts':
    'يَبحثُ في نصِّ JSON لنشاطِ إنشاءِ الطلب عن علامتَين كتبَهما بابُ /api/v1 بنفسه ("via":"api/v1" و"system":"…") — الإبرةُ من عندنا لا من إنسان، والمطابقةُ الحرفيةُ هي المقصود: اسمُ النظامِ يُقارَنُ كما هو',
  'lib/storefront.ts':
    'يَبحثُ عن اسمٍ لطيفٍ داخلَ مصفوفةِ JSON مخزونة — والاسمُ اللطيفُ صغيرُ الأحرفِ ببنائه، وهذا احتواءٌ في نصٍّ مُسلسَلٍ لا بحثُ إنسان',
};

/** Every .ts/.tsx under src, excluding tests — they are the sweep, not its subject. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      sources(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

interface Site {
  file: string;
  line: number;
  text: string;
}

/**
 * EVERY `contains:` IN THE PRODUCT, with comments stripped first.
 *
 * «A sweep that reads prose is worse than one that counts nothing» — this
 * repository has been bitten by it seven times, and `text-search.ts`'s own
 * header quotes `contains:` twice while explaining the rule. Reading those
 * as violations would make the sweep fail on its own documentation.
 */
function allSites(): Site[] {
  const out: Site[] = [];
  for (const file of sources(ROOT)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const src = stripComments(readFileSync(file, 'utf8'));
    src.split(/\r?\n/).forEach((text, i) => {
      if (text.includes('contains:')) out.push({ file: rel, line: i + 1, text: text.trim() });
    });
  }
  return out;
}

describe('Ⅰ · every search a person types ignores case', () => {
  const sites = allSites();

  it('finds the searches at all — a sweep that counts nothing proves nothing', () => {
    /*
     * The floor is deliberately low and present. If `stripComments` ever
     * ate the file, or the walk stopped at the first directory, this sweep
     * would pass by finding zero `contains:` anywhere — green over nothing,
     * which is the failure mode of every sweep in this repository that has
     * ever lied.
     */
    expect(sites.length, 'لم يُعثَرْ على أيِّ بحثٍ — المسحُ لا يَمسحُ شيئاً').toBeGreaterThanOrEqual(1);
  });

  it('and not one of them is left case-sensitive', () => {
    const bad = sites
      .filter((s) => !s.text.includes('insensitive'))
      .filter((s) => {
        // The type declaration inside the helper itself is the shape of the
        // answer, not a query. It is the ONE line that says `contains:` as
        // a field name rather than passing a needle.
        if (s.file === 'lib/text-search.ts') return false;
        return !(s.file in EXEMPT);
      });
    expect(
      bad,
      `بحثٌ يُطالبُ الكاتبَ بحالةِ الأحرف — استعمِلْ typed() من lib/text-search:\n${bad
        .map((s) => `  ${s.file}:${s.line}  ${s.text}`)
        .join('\n')}`
    ).toEqual([]);
  });

  it('and every exemption is still earning its place', () => {
    /*
     * An excuse list nobody prunes is how a sweep stops sweeping. If the
     * exempt file no longer has a bare `contains:`, the entry goes.
     */
    const stale = Object.keys(EXEMPT).filter(
      (file) => !sites.some((s) => s.file === file && !s.text.includes('insensitive'))
    );
    expect(stale, `استثناءٌ لم يَبقَ له سبب — احذِفْه:\n${stale.join('\n')}`).toEqual([]);
  });

  it('and every exemption says WHY, not just that it is excused', () => {
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `${file}: استثناءٌ بلا سبب`).toBeGreaterThan(30);
    }
  });
});

describe('Ⅱ · and the helper is the whole of the answer', () => {
  it('matches anywhere in the column, ignoring case', () => {
    expect(typed('gpmain')).toEqual({ contains: 'gpmain', mode: 'insensitive' });
  });

  it('and passes the term through untouched — it is not a spelling engine', () => {
    /*
     * Deliberately NOT `normalizeArabic`. That is the shopper's search
     * (`store-search.ts`), which folds spelling, ranks starts-with above
     * contains and tolerates a typo only after an exact pass found nothing.
     * Folding Arabic inside a `where` would match the FOLDED needle against
     * UNFOLDED stored text and find less than before, not more.
     */
    /*
     * EVERY TERM HERE CARRIES SOMETHING A FOLD WOULD CHANGE — asserted,
     * because the first version of this list was «الصويفية, GPMAIN, …»,
     * none of which contains a hamza, so a mutation that folded أ/إ/آ → ا
     * passed. A fixture that never supplies the dangerous input cannot see
     * the danger.
     */
    const TERMS = ['إدلب', 'أحمد', 'آية', 'حماة', 'شارع الملك الحسـين', 'GPMAIN', '  spaced  ', '٣٦'];
    const FOLDABLE = /[أإآٱةىـ]/;
    expect(
      TERMS.filter((t) => FOLDABLE.test(t)).length,
      'لا كلمةَ في التجربةِ يُغيِّرُها الطيّ — التجربةُ فارغة'
    ).toBeGreaterThanOrEqual(5);

    for (const term of TERMS) {
      expect(typed(term).contains, term).toBe(term);
    }
  });

  it('and the returns search — the one that was reported — goes through it', () => {
    /*
     * Named because it is the owner's own report, and because «it works
     * now» for one screen is what the sweep above is there to stop being
     * the whole fix. The sweep covers the other twenty-eight; this says the
     * reported one is among them.
     */
    // The search is written once, for every order list, in `orderSearchOr`; the returns filters ask it (and drop
    // the phone clauses for a person who may not read phones) instead of carrying a copy.
    const filters = stripComments(readFileSync(join(ROOT, 'lib/returns-filters.ts'), 'utf8'));
    expect(filters, 'بحثُ المرتجعاتِ لا يَمُرُّ بالبانيِ المشترك').toMatch(/orderSearchOr\(/);
    const builder = stripComments(readFileSync(join(ROOT, 'lib/order-filters.ts'), 'utf8'));
    expect(builder, 'البانيُ المشتركُ لا يَمُرُّ بالمساعد').toMatch(/typed\(/);
    for (const field of ['orderNumber', 'merchantRef', 'trackingNumber']) {
      expect(builder, `«${field}» خارجَ بحثِ المرتجعات`).toContain(field);
    }
  });
});
