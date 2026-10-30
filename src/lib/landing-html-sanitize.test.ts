import { describe, expect, it } from 'vitest';
import { injectPageStyles, sanitizeLandingCss, sanitizeLandingHtml } from './landing-html-sanitize';

/**
 * AN EVENT HANDLER IS REMOVED WHEREVER A PARSER WOULD SEE ONE.
 *
 * The rule matched `\son…=` — a handler after whitespace — so `<svg/onload=>`
 * and `<img src="x"onerror=>`, both real handlers to a browser, came back
 * untouched and ran as script in the uploaded page.
 */

const noHandler = (html: string) => !/on[a-z]+\s*=/i.test(html);

describe('inline event handlers', () => {
  it('after whitespace, as before', () => {
    expect(noHandler(sanitizeLandingHtml('<div onclick="x()">a</div>'))).toBe(true);
  });

  it('after a slash', () => {
    const out = sanitizeLandingHtml('<svg/onload=fetch("/api/x",{method:"PATCH"})><img/src="x"/onerror=alert(1)>');
    expect(noHandler(out)).toBe(true);
  });

  it('straight after a quoted value', () => {
    expect(noHandler(sanitizeLandingHtml(`<img src="x"onerror=alert(1)><a href='#'onmouseover='y()'>a</a>`))).toBe(true);
  });

  it('when removing one would splice two halves into a new one', () => {
    expect(noHandler(sanitizeLandingHtml('<img src=x /ononerror=error=alert(1)>'))).toBe(true);
  });

  it('leaves ordinary attributes and text alone', () => {
    const out = sanitizeLandingHtml('<p class="note" data-zaki-action="order">online offer</p>');
    expect(out).toContain('class="note"');
    expect(out).toContain('data-zaki-action="order"');
    expect(out).toContain('online offer');
  });
});

/**
 * AND THE TAG THE WHOLE FUNCTION EXISTS FOR.
 *
 * The file's own header lists `<script>` first among what it removes, and
 * nothing here asserted it — five tests, all about `on…=` handlers. The
 * gap was found while deleting `/api/public/landing-pages/[slug]/form.js`,
 * a public endpoint that served a bootstrap script for uploaded HTML to
 * load: it could have no consumer precisely BECAUSE this strip runs at
 * save time. A claim that lets a public endpoint be deleted should not
 * rest on reading the regex.
 */
describe('script tags', () => {
  const noScript = (html: string) => !/<\s*\/?\s*script/i.test(html);

  it('removes a plain block, content and all', () => {
    const out = sanitizeLandingHtml('<p>a</p><script>alert(1)</script><p>b</p>');
    expect(noScript(out)).toBe(true);
    expect(out).not.toContain('alert(1)');
    // And the page around it survives — this strips, it does not refuse.
    expect(out).toContain('<p>a</p>');
    expect(out).toContain('<p>b</p>');
  });

  it('removes one that only loads a src, which is the shape that mattered', () => {
    // Exactly what `form.js` would have needed in an uploaded page.
    const out = sanitizeLandingHtml(
      '<div id="zaki-order-form"></div><script src="/api/public/landing-pages/x/form.js"></script>'
    );
    expect(noScript(out)).toBe(true);
    expect(out).not.toContain('form.js');
    expect(out).toContain('id="zaki-order-form"');
  });

  it('is not fooled by case, spacing or attributes', () => {
    for (const bad of [
      '<SCRIPT>alert(1)</SCRIPT>',
      '<script type="text/javascript">alert(1)</script >',
      '<script\ndefer\nsrc="x.js"></script>',
      '<script >alert(1)</script>',
    ]) {
      expect(noScript(sanitizeLandingHtml(bad)), bad).toBe(true);
    }
  });

  it('and leaves no stray half of one behind', () => {
    // A lone opening or closing tag is still a parser instruction.
    expect(noScript(sanitizeLandingHtml('<p>a</p><script src="x.js">'))).toBe(true);
    expect(noScript(sanitizeLandingHtml('</script><p>a</p>'))).toBe(true);
  });

  it('and the word «script» in ordinary text is not a tag', () => {
    // A strip that eats prose is a strip people switch off.
    const out = sanitizeLandingHtml('<p>اكتب لنا النص script وسنرد عليك</p>');
    expect(out).toContain('اكتب لنا النص script وسنرد عليك');
  });
});

describe('the other active content the header promises to remove', () => {
  it('drops iframes, objects and embeds', () => {
    const out = sanitizeLandingHtml(
      '<iframe src="https://evil"></iframe><object data="x"></object><embed src="y">'
    );
    expect(out).not.toMatch(/<\s*iframe/i);
    expect(out).not.toMatch(/<\s*object/i);
    expect(out).not.toMatch(/<\s*embed/i);
  });

  it('neutralises a javascript: URL wherever it is written', () => {
    const out = sanitizeLandingHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toMatch(/javascript\s*:/i);
  });
});

/**
 * REMOVING A TAG CAN BUILD A NEW ONE — THE LESSON STEP 3 ALREADY KNEW.
 *
 * The handler strip loops «so removing one handler cannot splice two
 * fragments into a new one». That is a property of REMOVAL, not of
 * handlers, and the tag strips above it ran once each. MEASURED against
 * the single pass:
 *
 *   <scr<script>ipt>alert(1)</scr<script>ipt>  →  <script>alert(1)</script>
 *   <obj<object></object>ect data="x">         →  <object data="x">
 *
 * The first is a working script tag written into the database as
 * sanitized. The sandbox and the CSP remain the primary boundary — an
 * opaque origin cannot reach ours — but `allow-scripts` and
 * `allow-popups` are granted, and the page this becomes is where a
 * customer types their phone number and address.
 *
 * `<object>` carried a second hole: a pair rule and no lone-tag rule,
 * where `<iframe>` has both, so the spliced `<object …>` matched nothing.
 */
describe('a tag spliced out of two halves', () => {
  const noActive = (html: string) =>
    !/<\s*\/?\s*(script|iframe|object|embed|base)\b/i.test(html);

  it('does not leave a script behind', () => {
    const out = sanitizeLandingHtml('<scr<script>ipt>alert(1)</scr<script>ipt>');
    expect(out, 'نصفان التحما بعد الحذف فصارا وسماً عاملاً').not.toContain('<script>');
    expect(noActive(out)).toBe(true);
  });

  it('nor an object, which also had no lone-tag rule of its own', () => {
    const out = sanitizeLandingHtml('<obj<object></object>ect data="x">');
    expect(out).not.toContain('<object');
    expect(noActive(out)).toBe(true);
  });

  it('nor an iframe, an embed or a base', () => {
    for (const bad of [
      '<ifr<iframe></iframe>ame src="https://evil">',
      '<emb<embed>ed src="x">',
      '<ba<base>se href="https://evil/">',
    ]) {
      expect(noActive(sanitizeLandingHtml(bad)), bad).toBe(true);
    }
  });

  it('and keeps going until nothing changes, however deep the nesting', () => {
    // Three layers: one pass fixes none of it, two fix part.
    const out = sanitizeLandingHtml('<scr<scr<script></script>ipt></script>ipt>alert(1)');
    expect(noActive(out)).toBe(true);
  });

  it('while ordinary markup around it is untouched', () => {
    const out = sanitizeLandingHtml('<p class="a">نص</p><scr<script>ipt>x</script><p>ب</p>');
    expect(out).toContain('<p class="a">نص</p>');
    expect(out).toContain('<p>ب</p>');
    expect(noActive(out)).toBe(true);
  });
});

/**
 * A SCHEME WRITTEN AS CHARACTER REFERENCES IS STILL THAT SCHEME.
 *
 * The scheme test tolerates whitespace between the letters — the old
 * trick — and did not tolerate the letters being written as `&#106;`,
 * which a browser decodes before it reads the URL. MEASURED: both
 * `&#106;avascript:alert(1)` and `&#x6a;avascript:alert(1)` came back
 * untouched in an `href`.
 */
describe('a javascript: URL hidden in character references', () => {
  const dead = (html: string) => /href="#"/.test(html);

  it('is neutralised in decimal, hex and zero-padded form', () => {
    for (const bad of [
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<a href="&#x6a;avascript:alert(1)">x</a>',
      '<a href="&#0000106;avascript:alert(1)">x</a>',
      '<a href="&#106avascript:alert(1)">x</a>', // the semicolon is optional
    ]) {
      expect(dead(sanitizeLandingHtml(bad)), bad).toBe(true);
    }
  });

  it('and so is the plain form, which already worked', () => {
    expect(dead(sanitizeLandingHtml('<a href="javascript:alert(1)">x</a>'))).toBe(true);
    expect(dead(sanitizeLandingHtml('<a href="java\tscript:alert(1)">x</a>'))).toBe(true);
  });

  it('but an ordinary entity in an ordinary attribute is left exactly as written', () => {
    /*
     * The decode judges the value and is never written back. A sanitizer
     * that rewrites what it approves corrupts ordinary pages — `&amp;` in
     * a query string, `&#1575;` in a title.
     */
    const out = sanitizeLandingHtml('<a href="/x?a=1&amp;b=2" title="&#1575;">x</a>');
    expect(out).toContain('href="/x?a=1&amp;b=2"');
    expect(out).toContain('title="&#1575;"');
  });
});

/**
 * THE SECOND SWEEP — thirty-one known evasions, run against the function
 * rather than reasoned about. Five got through; each is a tag or an
 * attribute the list simply did not name, and the reason it mattered is on
 * each test.
 */
describe('tags the list did not name', () => {
  /*
   * `String.raw` IS LOAD-BEARING, and this helper was written without it.
   *
   * In a template literal, a backslash-s is an unrecognised escape and
   * evaluates to a plain «s», while a backslash-b is the BACKSPACE
   * character. So the pattern this built was «less-than, s, star, slash,
   * question, s, star, frameset, U+0008» — a thing that matches nothing —
   * inside a helper whose whole job is to say «this tag is not here».
   *
   * Every test below passed with the strip removed. That is how it was
   * caught: four mutations in a row came back MISSED while the function
   * was demonstrably still emitting a frameset, so the next step was to
   * doubt the test rather than the verdict.
   *
   * A guard that cannot fail is worse than no guard — it is a green tick
   * over an unprotected rule.
   */
  const gone = (html: string, tag: string) =>
    !new RegExp(String.raw`<\s*/?\s*${tag}\b`, 'i').test(html);

  it('`<frame>` and `<frameset>` — an iframe with a shorter name', () => {
    const out = sanitizeLandingHtml('<frameset><frame src="https://evil"></frameset>');
    expect(gone(out, 'frame')).toBe(true);
    expect(gone(out, 'frameset')).toBe(true);
    expect(out).not.toContain('evil');
  });

  it('`<plaintext>`, which has no closing tag and eats the rest of the page', () => {
    const out = sanitizeLandingHtml('<p>عرضنا</p><plaintext>كل ما بعده نصٌّ خام');
    expect(gone(out, 'plaintext')).toBe(true);
    // And what came before it is still a page.
    expect(out).toContain('<p>عرضنا</p>');
  });

  it('`<link>`, which fetches — the one thing an uploaded file may not do', () => {
    for (const rel of ['stylesheet', 'import', 'prefetch']) {
      const out = sanitizeLandingHtml(`<link rel="${rel}" href="https://evil/x">`);
      expect(gone(out, 'link'), rel).toBe(true);
      expect(out, rel).not.toContain('evil');
    }
  });

  it('`<applet>`, dead everywhere, removed with the rest', () => {
    expect(gone(sanitizeLandingHtml('<applet code="Evil.class"></applet>'), 'applet')).toBe(true);
  });

  it('and `<meta name="referrer">`, which overrides the header the route sends', () => {
    /*
     * `raw/route.ts` sends `Referrer-Policy: no-referrer`. A meta referrer
     * in the document overrides it, and `unsafe-url` then hands the full
     * URL of the seller's page to every third party the page touches. The
     * old rule matched `http-equiv` only, and this is not one.
     */
    const out = sanitizeLandingHtml('<meta name="referrer" content="unsafe-url">');
    expect(out).not.toMatch(/referrer/i);
    // The ordinary one is left alone — this strips a policy, not all metas.
    expect(sanitizeLandingHtml('<meta charset="utf-8">')).toContain('charset');
  });
});

describe('the submit target, both halves of it', () => {
  it('drops `action` on the form, as it always did', () => {
    const out = sanitizeLandingHtml('<form action="https://evil"><input name=a></form>');
    expect(out).not.toContain('action=');
    expect(out).toContain('<input name=a>');
  });

  it('and `formaction` on the button, which overrides it one tag down', () => {
    /*
     * The comment on that step promised «action/submit hijacking vectors»
     * and removed one of the two. A button's `formaction` wins over the
     * form's `action` when that button submits, so stripping the form's
     * alone left the hijack in place.
     */
    const out = sanitizeLandingHtml('<form><button formaction="https://evil">go</button></form>');
    expect(out).not.toMatch(/formaction/i);
    expect(out).not.toContain('evil');
    expect(out).toContain('go');
  });
});

describe('a <style> block is CSS, and is held to the CSS rules', () => {
  it('loses its @import, exactly as the CSS field does', () => {
    /*
     * The header says CSS is stripped of `@import` and friends, and that
     * was true of the style ATTRIBUTE and of the page's CSS field — not of
     * a `<style>` block in the uploaded HTML, which went through whole.
     * One rule was being enforced in one of its two places.
     */
    const out = sanitizeLandingHtml('<style>@import url("https://evil/x.css");body{color:red}</style>');
    expect(out).not.toMatch(/@import/i);
    expect(out).not.toContain('evil');
    // And the legitimate CSS beside it survives.
    expect(out).toContain('body{color:red}');
  });

  it('and its expression() too, with the block still a block', () => {
    const out = sanitizeLandingHtml('<style>a{width:expression(alert(1))}</style>');
    expect(out).not.toMatch(/expression/i);
    expect(out).toContain('<style>');
    expect(out).toContain('</style>');
  });
});

describe('a null byte is not whitespace, and the scheme test now knows', () => {
  it('neutralises a scheme split by a control character', () => {
    expect(sanitizeLandingHtml('<a href="java\u0000script:alert(1)">x</a>')).toContain('href="#"');
    expect(sanitizeLandingHtml('<a href="java\u000Bscript:alert(1)">x</a>')).toContain('href="#"');
  });

  it('and leaves an ordinary value alone', () => {
    expect(sanitizeLandingHtml('<a href="/عروض?a=1">x</a>')).toContain('href="/عروض?a=1"');
  });
});

describe('what the sanitizer removes, it removes WHOLE', () => {
  /*
   * `[^)]*` stopped at the FIRST `)`, which in `expression(alert(1))` is
   * the inner one. The vector went and a stray bracket stayed, so a parser
   * reading unbalanced CSS swallowed the declaration after it. A sanitizer
   * that leaves broken syntax breaks the pages it approved.
   */
  it('leaves no orphan bracket behind an expression()', () => {
    const out = sanitizeLandingCss('a{width:expression(alert(1))}');
    expect(out).not.toContain(')}');
    expect(out).toBe('a{width:}');
  });

  it('nor behind a url(javascript:…)', () => {
    const out = sanitizeLandingCss('a{background:url(javascript:alert(1))}');
    expect(out).toBe('a{background:url("#")}');
    expect(out).not.toContain('))');
  });
});

/**
 * AND WHAT IS DELIBERATELY NOT REMOVED, so nobody reads its absence as an
 * oversight on the next sweep.
 *
 * A remote font and a remote image both reach a third party from a
 * customer's browser. Neither is stripped, because `RAW_HTML_CSP` allows
 * them on purpose — `font-src 'self' data: https:` and
 * `img-src 'self' data: https:`. Sellers' pages use remote images as a
 * matter of course, and a sanitizer that contradicts the CSP is a second
 * policy. The leak they allow is an IP and a user agent, and it is the
 * platform's decision, not this function's.
 */
describe('remote media, allowed on purpose', () => {
  it('keeps a remote font and a remote image, as the CSP does', () => {
    expect(sanitizeLandingCss('@font-face{src:url(https://cdn/x.woff2)}')).toContain('cdn/x.woff2');
    expect(sanitizeLandingHtml('<img src="https://cdn/x.jpg">')).toContain('cdn/x.jpg');
  });
});

/**
 * A STYLE ELEMENT ENDS AT THE FIRST END TAG, WHATEVER CSS IS IN THE MIDDLE.
 *
 * The page's CSS field is wrapped in a style element by the raw route AFTER
 * the HTML sanitizer has run. `a{}</style><script>…` therefore needs the
 * CSS function itself to refuse it, and the same function holds a style
 * block inside uploaded HTML.
 */
describe('CSS cannot close its own style element', () => {
  const closes = (css: string) => /<\/\s*style/i.test(css);

  it('the plain breakout, with a script behind it', () => {
    const out = sanitizeLandingCss('a{color:red}</style><script>alert(1)</script>');
    expect(closes(out)).toBe(false);
    expect(out).toContain('a{color:red}');
  });

  it('in any case, and with whitespace before the name', () => {
    expect(closes(sanitizeLandingCss('</STYLE><img src=x onerror=alert(1)>'))).toBe(false);
    expect(closes(sanitizeLandingCss('</ style ><img src=x onerror=alert(1)>'))).toBe(false);
    expect(closes(sanitizeLandingCss('</StYlE/x>'))).toBe(false);
  });

  it('split by a comment, which is removed afterwards', () => {
    const out = sanitizeLandingCss('</sty/**/le><script>alert(1)</script>');
    expect(closes(out)).toBe(false);
  });

  it('doubled, so removing one cannot rejoin the other', () => {
    const out = sanitizeLandingCss('<</style/style>script>alert(1)</script>');
    expect(closes(out)).toBe(false);
  });

  it('what the raw route builds from it has exactly one end tag', () => {
    const doc = `<style>${sanitizeLandingCss('a{}</style><script>alert(1)</script><style>')}</style>`;
    expect(doc.match(/<\/style/gi)).toHaveLength(1);
    // the one end tag is the wrapper's own, the last thing in the document: whatever
    // the seller wrote sits inside the element as inert text
    expect(doc.toLowerCase().lastIndexOf('</style')).toBe(doc.length - '</style>'.length);
    expect(doc.toLowerCase().indexOf('</style')).toBe(doc.length - '</style>'.length);
  });

  it('a style block in uploaded HTML cannot end early with an end tag that has attributes', () => {
    const out = sanitizeLandingHtml('<style>a{}</style x="1"><img src=x onerror=alert(1)></style>');
    expect(out).not.toMatch(/onerror/i);
  });

  // negative: sound CSS passes untouched
  it('a bare < survives — a media query written without spaces still works', () => {
    const css = '@media (width<600px){.a{color:red}} .b::after{content:"a<b"}';
    expect(sanitizeLandingCss(css)).toBe(css);
  });

  it('ordinary CSS comes back byte for byte', () => {
    const css = 'body{margin:0;font:16px/1.5 "Cairo",sans-serif}.hero{background:url(https://cdn.example/x.jpg)}';
    expect(sanitizeLandingCss(css)).toBe(css);
  });
});

/**
 * A SCHEME SPELLED WITH THE NAMED REFERENCES.
 */
describe('javascript: written with named character references', () => {
  const dead = (html: string) => !/javascript/i.test(sanitizeLandingHtml(html).replace(/&[A-Za-z]+;/g, ''));

  it('&Tab; and &NewLine; inside the scheme', () => {
    expect(sanitizeLandingHtml('<a href="java&Tab;script:alert(1)">x</a>')).toContain('href="#"');
    expect(sanitizeLandingHtml('<a href="java&NewLine;script:alert(1)">x</a>')).toContain('href="#"');
  });

  it('&colon; for the colon', () => {
    expect(sanitizeLandingHtml('<a href="javascript&colon;alert(1)">x</a>')).toContain('href="#"');
    // the word alone would be caught either way; the colon is what a data: URL needs
    expect(sanitizeLandingHtml('<a href="data&colon;text/html;base64,PHNjcmlwdD4=">x</a>')).toContain('href="#"');
  });

  it('all three at once, and in another attribute as well', () => {
    expect(dead('<a href="ja&Tab;va&NewLine;script&colon;alert(1)">x</a>')).toBe(true);
    expect(sanitizeLandingHtml('<img src="java&Tab;script&colon;alert(1)">')).toContain('src="#"');
  });

  // negative: an ordinary link with entities in it is left alone
  it('a link with &amp; and a named entity that is not a scheme letter stays', () => {
    const html = '<a href="https://shop.example/p?a=1&amp;b=2&colon;3">x</a>';
    expect(sanitizeLandingHtml(html)).toBe(html);
  });

  it('text that merely mentions javascript is not a link and stays', () => {
    const html = '<p>learn javascript&colon; the basics</p>';
    expect(sanitizeLandingHtml(html)).toBe(html);
  });
});

/**
 * THE SELLER'S CSS IS SPLICED IN LITERALLY.
 */
describe('injectPageStyles', () => {
  const base = '<style id="b">body{}</style>';
  const custom = '<style id="c">a{}</style>';
  const doc = '<!doctype html><html><head><title>t</title></head><body>BODY-MARKER</body></html>';

  it('the base goes right after <head>, the seller css right before </head>', () => {
    const out = injectPageStyles(doc, base, custom);
    expect(out.indexOf('<head>' + base)).toBeGreaterThan(-1);
    expect(out).toContain(custom + '</head>');
    expect(out.indexOf(base)).toBeLessThan(out.indexOf('<title>'));
    expect(out.indexOf(custom)).toBeGreaterThan(out.indexOf('</title>'));
  });

  it('a $\' in the css does not paste the rest of the document into it', () => {
    const evil = `<style>a::after{content:"$'"}b::after{content:"$&"}c::after{content:"$\`"}</style>`;
    const out = injectPageStyles(doc, '', evil);
    expect(out).toContain(evil + '</head>');
    expect(out.match(/BODY-MARKER/g)).toHaveLength(1);
  });

  it('the same in the base styles', () => {
    const out = injectPageStyles(doc, `<style>x{content:"$'"}</style>`, '');
    expect(out.match(/BODY-MARKER/g)).toHaveLength(1);
  });

  it('<header> is not <head>', () => {
    const out = injectPageStyles('<header>H</header><p>x</p>', base, custom);
    expect(out).toBe(base + custom + '<header>H</header><p>x</p>');
  });

  it('a <head> with attributes still takes the base after its opening tag', () => {
    const out = injectPageStyles('<html><head lang="ar"><meta charset="utf-8"></head><body></body></html>', base, custom);
    expect(out).toContain('<head lang="ar">' + base + '<meta');
  });

  it('an opening <head> with no </head> gets both, base first', () => {
    const out = injectPageStyles('<head><title>t</title><body>x', base, custom);
    expect(out.startsWith('<head>' + base + custom)).toBe(true);
  });

  it('no head at all: both go to the front, as before', () => {
    expect(injectPageStyles('<p>x</p>', base, custom)).toBe(base + custom + '<p>x</p>');
  });

  // negative: nothing to inject, nothing changes
  it('with nothing to inject the document is returned as it came', () => {
    expect(injectPageStyles(doc, '', '')).toBe(doc);
  });
});
