import { describe, expect, it } from 'vitest';
import { sanitizeLandingCss, sanitizeLandingHtml, sanitizeLandingHtmlStrict } from './landing-html-sanitize';

/**
 * INPUT BUILT TO MAKE THE CLEANER CRAWL, AND THE PAGES THAT ARE NOT.
 *
 * (Where the page's styles go is in `landing-html-sanitize-structure.test.ts`.)
 */

/**
 * INPUT BUILT TO MAKE THE CLEANER CRAWL.
 *
 * Measured before the fix, on 256 KB: `<meta ` 8.9 s, `<script ` 5.2 s, a run
 * of letters 28 s. None of them is a page; every one is refused or cleaned in
 * a few milliseconds now. The budget the review set is 100 ms.
 */
describe('hostile input is cheap', () => {
  const N = 256 * 1024;
  const rep = (s: string) => s.repeat(Math.floor(N / s.length));
  const timed = <T>(fn: () => T): { ms: number; value: T } => {
    const t = performance.now();
    const value = fn();
    return { ms: performance.now() - t, value };
  };

  const hostile: Record<string, string> = {
    '<script> repeated, never closed': rep('<script>'),
    '<script  with no end': rep('<script '),
    '<iframe  with no end': rep('<iframe '),
    '<iframe> repeated, never closed': rep('<iframe>'),
    '<object  with no end': rep('<object '),
    '<applet> repeated': rep('<applet>'),
    '<meta  with no end': rep('<meta '),
    '<form  with no end': rep('<form '),
    '<style  with no end': rep('<style '),
    '<link  with no end': rep('<link '),
    '<base  with no end': rep('<base '),
    'end tags with no end': rep('</script '),
    'one long word': 'a'.repeat(N),
    'one long j': 'j'.repeat(N),
    'a= repeated': rep('a='),
    'comment openers': rep('<!--'),
    'svg styles': rep('<svg><style>'),
  };

  for (const [name, html] of Object.entries(hostile)) {
    it(`${name}: under 100 ms`, () => {
      const { ms } = timed(() => sanitizeLandingHtml(html));
      expect(ms).toBeLessThan(100);
    });
  }

  it('and what it cannot clean in that time it refuses, rather than saying it is clean', () => {
    expect(sanitizeLandingHtmlStrict(rep('<meta '))).toBeNull();
    expect(sanitizeLandingHtmlStrict(rep('<script '))).toBeNull();
    // refused is NOT the same answer as «nothing was left»
    expect(sanitizeLandingHtmlStrict('<script>alert(1)</script>')).toBe('');
    expect(sanitizeLandingHtml(rep('<meta '))).toBe('');
  });

  it('a start tag with no end tag still goes (it is not left for the browser to close)', () => {
    const out = sanitizeLandingHtml('<p>a</p><script>alert(1)<p>b</p><script>alert(2)');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('<p>a</p>');
  });

  it('and several complete pairs with text between them lose only the pairs', () => {
    const out = sanitizeLandingHtml('A<script>1</script>B<iframe src=x></iframe>C<object data=y></object>D<applet></applet>E');
    expect(out).toBe('ABCDE');
  });

  // negative: a big sound page is neither refused nor slow nor changed
  it('a 200 KB page of ordinary tags passes unchanged, quickly', () => {
    const page = '<!doctype html><html><head><title>t</title></head><body>' + '<div class="a"><p>نص <b>عرض</b></p><img src="https://cdn.example/x.jpg" alt="x"></div>\n'.repeat(2500) + '</body></html>';
    const { ms, value } = timed(() => sanitizeLandingHtmlStrict(page));
    expect(value).toBe(page);
    expect(ms).toBeLessThan(500);
  });

  it('a script full of comparisons next to arrows is still not mistaken for an attack', () => {
    const page = '<html><body><p>x</p><script>' + 'for (let i = 0; i < n; i++) { if (a < b) go(x => x); }\n'.repeat(400) + '</script></body></html>';
    expect(sanitizeLandingHtmlStrict(page)).not.toBeNull();
  });
});

/**
 * THE SAME FOR CSS: the page's CSS field, and every style block of a file.
 *
 * Measured before the fix: 85,000 copies of `/*a` (256 KB) took 3.9 s through
 * `sanitizeLandingHtmlStrict` and 4.2 s through `sanitizeLandingCss`, because
 * the comment pattern read to the end of the text from every opener — and an
 * unclosed comment stays in the stored row, so the cost came back on every
 * public visit to the page.
 */
describe('hostile css is cheap', () => {
  const N = 256 * 1024;
  const rep = (s: string) => s.repeat(Math.floor(N / s.length));
  const ms = (fn: () => unknown) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };

  const css: Record<string, string> = {
    'comment openers, never closed': rep('/*a'),
    'comment openers and a closer at the very end': rep('/*a') + '*/',
    'comment closers only': rep('*/'),
    'slash, comment, star (rejoins)': rep('//**/*'),
    'url( repeated': rep('url('),
    'url(j repeated': rep('url(j'),
    'url(javascript: repeated': rep('url(javascript:'),
    'expression( repeated': rep('expression('),
    'expression(( repeated': rep('expression(('),
    '@import repeated': rep('@import '),
    '@imp@import repeated': rep('@imp@import;ort '),
    'backslashes': rep('\\'),
    'escapes': rep('\\6'),
    'double quotes': rep('"'),
    'single quotes': rep("'"),
    'less-than and dashes': rep('<a-->'),
    'behavior: repeated': rep('behavior:'),
    'braces': rep('{'),
  };

  for (const [name, text] of Object.entries(css)) {
    it(`${name}: under 100 ms through the css door`, () => {
      expect(ms(() => sanitizeLandingCss(text))).toBeLessThan(100);
    });
    it(`${name}: under 100 ms inside a style block of a file`, () => {
      expect(ms(() => sanitizeLandingHtmlStrict(`<style>${text}</style>`))).toBeLessThan(100);
    });
  }

  it('an unclosed comment is cut to the end, as a browser does, and the css before it stays', () => {
    expect(sanitizeLandingCss('a{color:red}/* never closed {}')).toBe('a{color:red}');
    expect(sanitizeLandingCss(rep('/*a'))).toBe('');
  });

  // negative: comments that ARE closed are removed exactly, and nothing else changes
  it('closed comments come out and the css around them is untouched', () => {
    expect(sanitizeLandingCss('/* a */a{color:red}/* b */b{margin:0}')).toBe('a{color:red}b{margin:0}');
    expect(sanitizeLandingCss('a{/**/color:red}')).toBe('a{color:red}');
    expect(sanitizeLandingCss('/*/ not closed yet */a{x:y}')).toBe('a{x:y}');
  });

  it('a comment whose removal makes a new opener is still cut', () => {
    expect(sanitizeLandingCss('/' + '/**/' + '*x')).toBe('');
  });
});

/**
 * A REAL PROJECT FILE IS NOT AN ATTACK.
 *
 * The first version of the guard added up the distance from EVERY `<` to the
 * next `>`. An inline script that compares things with `<` and has no `>` in
 * it for a hundred kilobytes is an ordinary page and was refused. The guard
 * now counts only the starts the rules actually key on (`<script`, `<meta`,
 * `<form` …), and this is the page that proves it.
 */
describe('a big, ordinary project file passes the strict door', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `if (a${i} < b${i}) { totals[${i}] = a${i} + b${i}; }`).join('\n');

  it('300 KB of inline script made of `<` comparisons and no `>`', () => {
    const page = `<!doctype html><html><head><title>t</title></head><body><p>x</p><script>${rows(6000)}</script></body></html>`;
    expect(page.length).toBeGreaterThan(250 * 1024);
    const out = sanitizeLandingHtmlStrict(page);
    expect(out).not.toBeNull();
    // the script itself is removed — that is the cleaner doing its job, not the guard refusing
    expect(out).toBe('<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>');
  });

  it('a comparison table in the text, `<` unescaped, 5,000 rows', () => {
    const table = '<table>' + Array.from({ length: 5000 }, (_, i) => `<tr><td>${i} < ${i + 1}</td><td>ok</td></tr>`).join('') + '</table>';
    const out = sanitizeLandingHtmlStrict(table);
    expect(out).toBe(table);
  });

  it('a page that really has hundreds of forms and metas, each closed, passes', () => {
    const page = '<head>' + '<meta charset="utf-8">'.repeat(300) + '</head><body>' + '<form method="post"><input name="p"></form>'.repeat(300) + '</body>';
    expect(sanitizeLandingHtmlStrict(page)).not.toBeNull();
  });
});
