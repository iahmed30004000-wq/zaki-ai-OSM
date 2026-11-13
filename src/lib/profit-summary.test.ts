import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PROFIT_FIELDS, ZERO_SUMMARY } from './profit-summary';
import { stripComments } from './guard-source';

/**
 * THE SCREEN THAT DIED RATHER THAN SHOWING A ZERO.
 *
 * The profit screen kept its own idea of what a summary looks like, for the
 * moment before the server answers. The server's idea then gained a field —
 * `shippingAndCommissions`, added so the two numbers are summed once, on the
 * side that knows the rules — and the screen's copy did not.
 *
 * So the screen read `summary.shippingAndCommissions.toFixed(2)` on an
 * object with no such field. Not a wrong number: a crash, and the whole
 * screen rendered as "This page couldn't load" — every time the server was
 * slow, restarting, or briefly unreachable, which is precisely the moment
 * the fallback existed to survive.
 *
 * Found by opening the screen. Nothing else could have found it: the
 * fallback is only reached when the server fails, and the server does not
 * fail in a test that mocks it.
 */

const SCREEN = 'src/components/screens/FinanceProfitScreen.tsx';
// MOVED (13/11): the server's `summary` is built in `profitToDate` — the one function the profit screen and the partners'
// statement both read — and the route hands it on. The guard follows the object to where it is made.
const API = 'src/lib/profit-to-date.ts';
const ROUTE = 'src/app/api/finance/route.ts';
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('the profit summary has one shape', () => {
  it('and the route sends the one `profitToDate` made, not a second one of its own', () => {
    const src = stripComments(read(ROUTE));
    expect(src, 'الباب لم يعد يأخذ الملخّص من profitToDate').toMatch(/const \{[^}]*\bsummary\b[^}]*\} = await profitToDate\(/);
    expect(src, 'عاد الباب يبني ملخّصاً بنفسه').not.toContain('const summary');
    expect(src, 'عاد الباب يحسب الصافي بنفسه').not.toMatch(/\bnetProfit\s*=/);
  });

  it('and the server fills exactly it', () => {
    const src = read(API);
    // The server's object is typed, so a missing field is a compile error
    // rather than a crash on somebody's screen.
    expect(src, 'الخادم لم يعد يلتزم بالشكل الواحد').toContain('const summary: ProfitSummary');
    for (const field of PROFIT_FIELDS) {
      expect(src, `الخادم لا يرسل ${field}`).toContain(`${field}:`);
    }
  });

  it('and the screen reads nothing the zero does not have', () => {
    // The exact failure, stated as a rule: every field the screen touches
    // must exist on the object it falls back to.
    const src = read(SCREEN);
    const touched = [...src.matchAll(/summary\.(\w+)/g)].map((m) => m[1]);
    expect(touched.length, 'الشاشة لم تعد تقرأ الملخّص إطلاقاً').toBeGreaterThan(4);
    const missing = [...new Set(touched)].filter((f) => !(f in ZERO_SUMMARY));
    expect(missing, `حقولٌ تقرأها الشاشة ولا وجود لها عند الفشل: ${missing.join('، ')}`).toEqual([]);
  });

  it('and falls back to the shared zero, not to another copy of it', () => {
    const src = read(SCREEN);
    expect(src).toContain('ZERO_SUMMARY');
    // A second literal with these fields is a second shape, which is how
    // the first one drifted.
    expect(
      /const summary[^=]*=\s*data\?\.summary\s*\|\|\s*\{/.test(src),
      'عادت نسخةٌ ثانية من الشكل داخل الشاشة'
    ).toBe(false);
  });

  it('starts at zero rather than at nothing', () => {
    for (const field of PROFIT_FIELDS) expect(ZERO_SUMMARY[field]).toBe(0);
  });
});

/**
 * THE OTHER HALF OF THE SAME SCREEN.
 *
 * Four figures were printed as `${n.toFixed(2)} {data?.currency ?? ''}`.
 * Inside a template literal `{x}` is not a value, it is the characters
 * `{x}` — so the cards showed the reader the source of the expression
 * instead of the currency, in a system that runs three of them side by
 * side. Another thing only opening the screen finds.
 */
function screens(dir: string): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...screens(p));
    else if ((p.endsWith('.tsx') || p.endsWith('.ts')) && !p.includes('.test.')) {
      out.push({ rel: relative(process.cwd(), p).split('\\').join('/'), src: readFileSync(p, 'utf8') });
    }
  }
  return out;
}

describe('a value inside a template string', () => {
  it('is never written the JSX way, which prints the code instead', () => {
    const offenders: string[] = [];
    for (const { rel, src } of screens(join(process.cwd(), 'src'))) {
      // COMMENTS FIRST. A doc comment that writes the correct spelling of
      // this very mistake is prose, not markup — and this guard reported
      // one as an offence, which is the fifth time in this work that a rule
      // has failed on the sentence explaining it. `stripComments` keeps the
      // line count, so the numbers below still point at the right line.
      for (const [i, line] of stripComments(src).split('\n').entries()) {
        if (!line.includes('`')) continue;
        // Split the LINE on backticks: the odd pieces are inside a
        // template literal, the even ones are ordinary JSX. Pairing
        // backticks across the whole file invents literals out of the
        // unrelated code that happens to sit between two of them, and
        // testing "the line has a backtick somewhere" flags correct JSX
        // that shares a line with one.
        const pieces = line.split('`');
        for (let k = 1; k < pieces.length; k += 2) {
          for (const m of pieces[k].matchAll(/(?<![$\{])\{[a-zA-Z_][\w]*(?:\?\.|\.)[\w?. ]*(?:\?\?[^}]*)?\}/g)) {
            // `{{name}}` is a deliberate placeholder in the landing-page
            // editor's snippets, not a failed interpolation.
            if (pieces[k].slice(Math.max(0, (m.index ?? 0) - 1), m.index) === '{') continue;
            offenders.push(`${rel}:${i + 1}: ${m[0].slice(0, 40)}`);
          }
        }
      }
    }
    expect(offenders, `تعبيرٌ يُطبع كنصّ بدل أن يُحسب:\n${offenders.join('\n')}`).toEqual([]);
  });
});
