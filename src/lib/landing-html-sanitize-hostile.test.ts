import { describe, expect, it } from 'vitest';
import { sanitizeLandingCss, sanitizeLandingHtml, sanitizeLandingHtmlStrict } from './landing-html-sanitize';

/**
 * HOW THESE TESTS TELL «SLOW» FROM «QUADRATIC».
 *
 * They are timing tests, and a timing test has two ways to lie: a slow shared
 * CI machine (the first version used 100 ms and failed at 114.8 ms and 117.4 ms
 * on inputs that take 20 ms here — nothing to do with security), and a fast
 * one that lets a real regression through. What separates the two is the SHAPE
 * of the cost, not its size: the crawls this file guards against took seconds
 * (3.9 s, 4.3 s, 17.8 s, 28 s on 256-512 KB), and linear work on the same
 * input takes tens of milliseconds. So the budget is 750 ms — an order of
 * magnitude above the slowest CI run seen and far below the cheapest crawl —
 * and each measurement is the BEST of three runs, which drops a one-off pause
 * (GC, a noisy neighbour) instead of failing on it. A crawl is slow every time.
 */
const BUDGET_MS = 750;
const RUNS = 3;
function bestOf<T>(fn: () => T): { ms: number; value: T } {
  let best = Infinity;
  let value: T | undefined;
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    value = fn();
    best = Math.min(best, performance.now() - t);
  }
  return { ms: best, value: value as T };
}

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
 * a few milliseconds now. The budget is explained at the top of the file.
 */
describe('hostile input is cheap', () => {
  const N = 256 * 1024;
  const rep = (s: string) => s.repeat(Math.floor(N / s.length));
  const timed = bestOf;

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
    it(`${name}: under ${BUDGET_MS} ms`, () => {
      const { ms } = timed(() => sanitizeLandingHtml(html));
      expect(ms).toBeLessThan(BUDGET_MS);
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
    expect(ms).toBeLessThan(BUDGET_MS);
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
  const ms = (fn: () => unknown) => bestOf(fn).ms;

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
    it(`${name}: under ${BUDGET_MS} ms through the css door`, () => {
      expect(ms(() => sanitizeLandingCss(text))).toBeLessThan(BUDGET_MS);
    });
    it(`${name}: under ${BUDGET_MS} ms inside a style block of a file`, () => {
      expect(ms(() => sanitizeLandingHtmlStrict(`<style>${text}</style>`))).toBeLessThan(BUDGET_MS);
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

/**
 * A TAG THAT IS DELETED CAN JOIN WHAT WAS ON EITHER SIDE OF IT.
 *
 * `<meta <script>` repeated passes a guard that looks only at the input (every
 * `<meta` has a `>` nearby — the script tag's), and the rule that removes
 * `<script>` turns it into `<meta <meta <meta …` with no `>` anywhere. Measured:
 * 128 KB = 0.96 s, 256 KB = 4.3 s, 512 KB = 17.8 s.
 */
describe('deleting a tag does not make the rest crawl', () => {
  const N = 256 * 1024;
  const rep = (s: string, bytes = N) => s.repeat(Math.floor(bytes / s.length));
  const ms = (fn: () => unknown) => bestOf(fn).ms;
  const joins: Record<string, string> = {
    '<meta <script>': rep('<meta <script>'),
    '<form <script>': rep('<form <script>'),
    '<style <script>': rep('<style <script>'),
    '<form <object>': rep('<form <object>'),
    '<meta <iframe>': rep('<meta <iframe>'),
    '<form <applet>': rep('<form <applet>'),
    '<meta <embed>': rep('<meta <embed>'),
    '<meta <link>': rep('<meta <link>'),
    '<form <base>': rep('<form <base>'),
    '<meta <frame>': rep('<meta <frame>'),
    '<meta <plaintext>': rep('<meta <plaintext>'),
    '<meta <script> at 512 KB': rep('<meta <script>', 512 * 1024),
  };

  for (const [name, html] of Object.entries(joins)) {
    it(`${name}: under ${BUDGET_MS} ms, and refused rather than cleaned slowly`, () => {
      let out: string | null = '';
      expect(ms(() => { out = sanitizeLandingHtmlStrict(html); })).toBeLessThan(BUDGET_MS);
      expect(out).toBeNull();
    });
  }

  it('nested to depth: each deletion exposes the next join', () => {
    // <meta <meta <script>> … : removing the innermost script joins the metas around it
    const depth = 2000;
    const html = '<meta '.repeat(depth) + '<script>' + '>'.repeat(depth);
    expect(ms(() => sanitizeLandingHtmlStrict(html))).toBeLessThan(BUDGET_MS);
    const big = '<meta <script>'.repeat(4000) + '<meta '.repeat(20000);
    expect(ms(() => sanitizeLandingHtmlStrict(big))).toBeLessThan(BUDGET_MS);
  });

  it('through the lenient door the answer is empty, and as fast', () => {
    expect(ms(() => expect(sanitizeLandingHtml(joins['<meta <script>'])).toBe(''))).toBeLessThan(BUDGET_MS);
  });

  // negative: the same tags, ordinary and closed, are a page
  it('a page with a real script, object, iframe, meta and form each next to its neighbour is not refused', () => {
    const page =
      '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body>' +
      '<form method="post"><input name="p"></form><script>if (a<b) go();</script><object data="x"></object>' +
      '<iframe src="y"></iframe><form method="post"><button>اطلب</button></form></body></html>';
    const out = sanitizeLandingHtmlStrict(page);
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/<script|<object|<iframe/);
    expect(out).toContain('<form method="post"><input name="p"></form>');
  });

  it('a tag broken by a deleted neighbour — a few of them — is cleaned, not refused', () => {
    expect(sanitizeLandingHtmlStrict('<meta <script>alert(1)</script> charset="utf-8"><p>x</p>')).not.toBeNull();
  });

  it('inline script full of `a<b`, and a huge comparison table, still pass after the deletions', () => {
    const js = Array.from({ length: 8000 }, (_, i) => `if (v${i} < w${i}) n++;`).join('\n');
    const table = '<table>' + Array.from({ length: 4000 }, (_, i) => `<tr><td>${i} < ${i + 1}</td></tr>`).join('') + '</table>';
    const page = `<html><body><script>${js}</script>${table}<form method="post"></form><meta charset="utf-8"></body></html>`;
    const out = sanitizeLandingHtmlStrict(page);
    expect(out).not.toBeNull();
    expect(out).toContain(table);
  });
});

/**
 * CLEANING WHAT WAS ALREADY CLEANED CHANGES NOTHING.
 */
describe('the css cleaner reaches a fixed point', () => {
  const payloads = [
    '@\\69behavior:x;mport url(https://evil.example/x.css);',
    '@\\69mport url(//evil/x.css);.a{color:red}',
    '@/**/import url(https://evil/x.css);',
    '@imp@import;ort url(https://evil/x.css);',
    'a{width:expr/**/ession(alert(1))}',
    'a{width:expression(alert(1))}',
    'a{background:url(javascript:alert(1))}',
    'a{background:url(\\6a avascript:alert(1))}',
    'a{background:url(j\\61vascript:alert(1))}',
    'a{}</style><script>alert(1)</script>',
    '</sty/**/le><script>alert(1)</script>',
    '<</style/style>script>alert(1)</script>',
    '--><img src=x onerror=alert(1)><!--',
    '.a::after{content:"a<b"}',
    '@media (width<600px){.a{color:red}} .b>.c{margin:0}',
    '.i::before{content:"\\f101"}.q::before{content:"\\201C "}.n::after{content:"a\\A b"}',
    '.h{background:url(https://cdn.example/x.jpg)}@font-face{src:url(https://cdn.example/f.woff2)}',
    'a{color:red}/* never closed {}',
    '/* a */a{color:red}/* b */b{margin:0}',
    '/' + '/**/' + '*x',
    'a{background:url(java/**/script:alert(1))}',
    'behavior:url(x);-moz-binding:url(y);',
    '@\\000069mport url(//evil/x.css);',
    '@\\69 mport url(//evil/x.css);',
    '',
  ];

  for (const css of payloads) {
    it(`f(f(x)) = f(x) for ${JSON.stringify(css).slice(0, 60)}`, () => {
      const once = sanitizeLandingCss(css);
      expect(sanitizeLandingCss(once)).toBe(once);
    });
  }

  it('and the rejoining payload is gone, not just stable', () => {
    const out = sanitizeLandingCss('@\\69behavior:x;mport url(https://evil.example/x.css);.a{color:red}');
    expect(out).not.toMatch(/evil/);
    expect(out).toContain('.a{color:red}');
  });

  it('the same through a style block of an uploaded file', () => {
    const once = sanitizeLandingHtml('<style>@\\69behavior:x;mport url(https://evil.example/x.css);</style>');
    expect(once).not.toMatch(/evil/);
    expect(sanitizeLandingHtml(once)).toBe(once);
  });
});
