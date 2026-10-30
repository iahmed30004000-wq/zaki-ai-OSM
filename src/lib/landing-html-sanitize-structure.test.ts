// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { injectPageStyles } from './landing-html-sanitize';

/**
 * WHERE THE PAGE'S STYLES GO — AND THAT NO INPUT CAN CHANGE IT.
 *
 * The fourth round of the security review ended the search for `</head>`.
 * Looking for it in text, then with a scanner that mirrored the HTML
 * tokenizer, then with that scanner checking itself, were each beaten by an
 * input a real browser reads differently (a quote in an unquoted value;
 * `<svg><title>`, `<svg><textarea>`, `<svg><xmp>`, `<svg><noembed>` and
 * `<math><title>` — foreign content, where the tokenizer's rules change).
 * The styles now go at the START of the document, behind only what can be
 * matched from the first character: whitespace, complete comments, a
 * `<?xml … ?>`, the doctype.
 *
 * These tests do not trust a scanner of ours either. The output is parsed by
 * the parser a browser's is built to match (jsdom's, parse5), and what it
 * builds is compared with what it builds from the document WITHOUT the
 * styles: the injection must add no element and no attribute that matters.
 */

const style = (css: string) => `<style id="zaki-custom-style">${css}</style>`;
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

/** What an injected attacker could add: a refresh, a referrer policy, a base, a form target. */
const consequential = (html: string) => {
  const d = parse(html);
  return {
    refresh: d.querySelectorAll('meta[http-equiv]').length,
    referrer: d.querySelectorAll('meta[name="referrer" i]').length,
    base: d.querySelectorAll('base').length,
    formAction: d.querySelectorAll('[action],[formaction]').length,
    handlers: Array.from(d.querySelectorAll('*')).filter((e) => e.getAttributeNames().some((a) => a.startsWith('on'))).length,
    scripts: d.querySelectorAll('script').length,
  };
};

describe('the payloads that beat the head search', () => {
  const places: [string, string][] = [
    ['svg', 'title'],
    ['svg', 'textarea'],
    ['math', 'title'],
    ['svg', 'xmp'],
    ['svg', 'noembed'],
  ];
  const quotes = ["'", '"', ''];

  for (const [ns, tag] of places) {
    for (const q of quotes) {
      const html = `<${ns}><${tag}><meta x=${q}</${tag}></head>${q}>`;
      const css = `${q || '>'} http-equiv=refresh content=0;url=https://evil.example x=${q}`;
      it(`<${ns}><${tag}> with ${q ? `${q} quotes` : 'no quotes'}: the parser builds nothing new`, () => {
        const out = injectPageStyles(html, '', style(css));
        expect(consequential(out)).toEqual(consequential(html));
        expect(consequential(out).refresh).toBe(0);
        // and the document itself was not touched: the styles are the only difference
        expect(out.replace(/<style id="zaki-custom-style">[\s\S]*?<\/style>/, '')).toBe(html);
        expect(out.startsWith('<style')).toBe(true);
      });
    }
  }

  it('the original payload (a quote inside an unquoted value, a meta in a quoted one)', () => {
    for (const q of ["'", '"']) {
      const html = `<p x=a${q}><meta name=x data=${q}</head>${q}>`;
      const out = injectPageStyles(html, '', style(`${q} http-equiv=refresh content=0;url=https://evil.example x=${q}`));
      expect(consequential(out)).toEqual(consequential(html));
    }
  });

  it('a form action, a referrer policy and a base are not added either', () => {
    const html = "<svg><title><meta x='</title></head>'>";
    for (const css of ["' action=//evil.example x='", "' name=referrer content=unsafe-url x='", "'><base href=//evil.example><meta x='"]) {
      expect(consequential(injectPageStyles(html, '', style(css)))).toEqual(consequential(html));
    }
  });

  it('a script or a handler written in the css field is not live', () => {
    const html = '<svg><title><b x="</title></head>">';
    const out = injectPageStyles(html, '', style('"><script>alert(1)</script><img src=x onerror=alert(1)><b x="'));
    expect(consequential(out).scripts).toBe(0);
    expect(consequential(out).handlers).toBe(0);
  });
});

describe('the start of a document', () => {
  const css = style('a{color:red}');
  const mode = (html: string) => parse(html).compatMode;

  it('goes after the doctype, never before it (quirks mode)', () => {
    const html = '<!doctype html><html><head><title>t</title></head><body>BODY</body></html>';
    const out = injectPageStyles(html, '', css);
    expect(out).toBe('<!doctype html>' + css + '<html><head><title>t</title></head><body>BODY</body></html>');
    expect(mode(out)).toBe('CSS1Compat');
    expect(mode(out)).toBe(mode(html));
  });

  it('goes after an <?xml … ?> declaration as well', () => {
    const html = '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html><body>x</body></html>';
    const out = injectPageStyles(html, '', css);
    expect(out.indexOf('<style')).toBeGreaterThan(out.indexOf('<!DOCTYPE html>'));
    expect(out.indexOf('<style')).toBeLessThan(out.indexOf('<html>'));
    expect(mode(out)).toBe(mode(html));
    expect(mode(out)).toBe('CSS1Compat');
  });

  it('goes after comments and whitespace before the doctype, and after a byte-order mark', () => {
    const html = '<!-- made by hand -->\n<!-- and </head> in this one -->\n<!doctype html>\n<!-- after -->\n<html><body>x</body></html>';
    const out = injectPageStyles(html, '', css);
    expect(out.indexOf('<style')).toBeGreaterThan(out.indexOf('<!doctype html>'));
    expect(mode(out)).toBe('CSS1Compat');
    // a BOM kept as a character is not whitespace to the parser (a browser strips it as a byte) — the mode is whatever it was
    const withBom = '﻿' + html;
    const out2 = injectPageStyles(withBom, '', css);
    expect(out2.indexOf('<style')).toBeGreaterThan(out2.indexOf('<!doctype html>'));
    expect(mode(out2)).toBe(mode(withBom));
  });

  it('an unclosed comment at the start is left alone and the styles go in front of it', () => {
    const html = '<!-- never closed <html><body>x</body></html>';
    const out = injectPageStyles(html, '', css);
    expect(out).toBe(css + html);
  });

  it('text before the doctype: the page was in quirks mode already, and still is', () => {
    const html = 'hello<!doctype html><html><body>x</body></html>';
    const out = injectPageStyles(html, '', css);
    expect(out).toBe(css + html);
    expect(mode(out)).toBe(mode(html));
  });

  it('no doctype at all: the styles are first, as they always were', () => {
    expect(injectPageStyles('<p>x</p>', '', css)).toBe(css + '<p>x</p>');
  });

  it('a document with no head, with a <header>, and with a </head> in its text is read the same', () => {
    for (const html of ['<!doctype html><header>H</header><p>x</p>', '<!doctype html><p>a &lt;/head&gt; b</p>', "<!doctype html><p title='</head>'>x</p>"]) {
      const out = injectPageStyles(html, '', css);
      expect(out).toBe('<!doctype html>' + css + html.slice('<!doctype html>'.length));
    }
  });

  it('the file’s own <html lang> and <head> still merge into the one the styles opened', () => {
    const html = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>t</title></head><body>x</body></html>';
    const d = parse(injectPageStyles(html, '', css));
    expect(d.documentElement.getAttribute('lang')).toBe('ar');
    expect(d.documentElement.getAttribute('dir')).toBe('rtl');
    expect(d.head.querySelector('title')?.textContent).toBe('t');
    expect(d.head.querySelector('meta[charset]')).not.toBeNull();
    expect(d.head.querySelector('#zaki-custom-style')).not.toBeNull();
    expect(d.querySelectorAll('head')).toHaveLength(1);
    expect(d.body.textContent).toBe('x');
  });
});

describe('what goes in, in what order', () => {
  const base = '<style id="zaki-base-style">html body{margin:0}</style>';
  const custom = '<style id="zaki-custom-style">a{color:red}</style>';
  const own = '<style>body{background:red}</style>';

  it('the settings first, then the seller css, both ahead of the file’s own style', () => {
    const out = injectPageStyles(`<!doctype html><html><head>${own}</head><body></body></html>`, base, custom);
    expect(out.indexOf(base)).toBeLessThan(out.indexOf(custom));
    expect(out.indexOf(custom)).toBeLessThan(out.indexOf(own));
  });

  it('a $\' in the css does not paste the rest of the document into it', () => {
    const evil = `<style>a::after{content:"$'"}b::after{content:"$&"}</style>`;
    const out = injectPageStyles('<!doctype html><p>BODY-MARKER</p>', '', evil);
    expect(out).toContain(evil);
    expect(out.match(/BODY-MARKER/g)).toHaveLength(1);
  });

  it('what is injected is cleaned on its own first', () => {
    const out = injectPageStyles('<p>x</p>', '', '<style id="c">a{}</style><img src=x onerror=alert(1)>');
    expect(out).not.toMatch(/onerror/i);
  });

  it('with nothing to inject the document is returned as it came', () => {
    expect(injectPageStyles('<!doctype html><p>x</p>', '', '')).toBe('<!doctype html><p>x</p>');
  });
});
