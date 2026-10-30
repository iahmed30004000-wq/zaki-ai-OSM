/**
 * LANDING PAGE HTML/CSS SANITIZER — server-side, Phase 1.
 *
 * Uploaded/edited landing HTML is untrusted content. It is ONLY ever served
 * inside a sandboxed iframe (opaque origin, see /lp/[slug]) and CSP'd, but we
 * sanitize at SAVE time as defense in depth so the stored artifact itself
 * carries no active content:
 *   - <script> tags (anywhere, incl. inside attributes tricks)
 *   - inline event handlers (on*)
 *   - javascript: / vbscript: / data:text/html URLs (href, src, action, ...)
 *   - <iframe>, <object>, <embed>, <base>, <meta http-equiv=refresh>
 *   - form action hijacking (forms are allowed but action is dropped; the
 *     trusted Zaki order flow never relies on uploaded forms)
 * CSS is stripped of expression()/behavior/@import/javascript: vectors.
 *
 * This is a pragmatic whitelist-leaning filter (no full DOM parser deps in
 * Phase 1); the sandbox + CSP remain the primary isolation boundary.
 */

export const MAX_LANDING_CSS_BYTES = 512 * 1024;

export interface LandingPageSettings {
  width?: 'full' | 'contained';
  maxWidth?: number;
  background?: string;
  direction?: 'rtl' | 'ltr';
  fontFamily?: string;
}

/**
 * NUMERIC CHARACTER REFERENCES, DECODED FOR THE SCHEME TEST ONLY.
 *
 * A browser decodes `&#106;` to `j` before it parses an attribute as a URL,
 * so `href="&#106;avascript:alert(1)"` is a javascript: URL however it
 * looks in the source. Decimal, hex and zero-padded forms all work, and the
 * trailing semicolon is optional in HTML.
 *
 * The decoded text is used to JUDGE the value and is never written back:
 * a clean value keeps its original bytes, entities and all, because a
 * sanitizer that rewrites what it approves is a sanitizer that corrupts
 * ordinary pages.
 */
function decodeCharRefs(value: string): string {
  /*
   * CONTROL CHARACTERS GO FIRST. The scheme pattern tolerates whitespace
   * between the letters, and a NUL or a vertical tab is not whitespace to a
   * regex — `href="java\u0000script:…"` came back untouched. Browsers mangle
   * a raw NUL in an attribute, so this is depth rather than a live hole, but
   * «probably mangled» is not the standard the rest of this file holds.
   */
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    /*
     * THE NAMED REFERENCES A SCHEME CAN BE SPELLED WITH. `&Tab;` and
     * `&NewLine;` are characters a URL parser deletes from inside a scheme
     * (`java&Tab;script:` is `javascript:`), and `&colon;` is the colon.
     * Names are case-sensitive in HTML, so they are matched exactly. Like
     * the numeric ones they JUDGE the value and are never written back.
     */
    .replace(/&(?:Tab|NewLine);/g, '')
    .replace(/&colon;/g, ':')
    .replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (whole, body: string) => {
    const code = body[0]?.toLowerCase() === 'x' ? parseInt(body.slice(1), 16) : parseInt(body, 10);
    // Surrogates and out-of-range code points make `fromCodePoint` throw;
    // they are not letters of a scheme, so the original text is kept.
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
    if (code >= 0xd800 && code <= 0xdfff) return whole;
    return String.fromCodePoint(code);
  });
}

/** Sanitize untrusted landing HTML. Returns cleaned HTML string. */
export function sanitizeLandingHtml(html: string): string {
  let out = html ?? '';

  /*
   * 1+2) REMOVE ACTIVE TAGS — REPEATEDLY, FOR THE REASON STEP 3 ALREADY
   *      GIVES ABOUT HANDLERS.
   *
   * These ran once each. Step 3 loops «so removing one handler cannot
   * splice two fragments into a new one», and that is a property of
   * removal itself, not of handlers — but the lesson had only been applied
   * to half the function. MEASURED against the single pass:
   *
   *   <scr<script>ipt>alert(1)</scr<script>ipt>   →  <script>alert(1)</script>
   *   <obj<object></object>ect data="x">          →  <object data="x">
   *
   * Removing the inner tag rejoined `<scr` with `ipt>` into a working
   * script tag, and the result went to the database as sanitized. The
   * sandbox and the CSP are still the primary boundary — an opaque origin
   * cannot reach ours — but `allow-scripts` and `allow-popups` are granted,
   * and the page this HTML becomes is where a customer types their phone
   * number and address.
   *
   * `<object>` had a second hole of its own: a PAIR rule and no lone-tag
   * rule, where `<iframe>` has both. The splice left a lone `<object …>`
   * that nothing then matched.
   *
   * The loop terminates because every rule only ever deletes characters.
   */
  for (let before = ''; before !== out; ) {
    before = out;
    // Script blocks (multiline, case-insensitive), then stray halves.
    out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
    out = out.replace(/<\/?script\b[^>]*>/gi, '');
    // Dangerous containers, each with a PAIR rule and a LONE-TAG rule.
    out = out.replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, '');
    out = out.replace(/<\/?iframe\b[^>]*\/?>/gi, '');
    out = out.replace(/<object\b[\s\S]*?<\/object\s*>/gi, '');
    out = out.replace(/<\/?object\b[^>]*\/?>/gi, '');
    out = out.replace(/<\/?embed\b[^>]*\/?>/gi, '');
    out = out.replace(/<base\b[^>]*>/gi, '');
    /*
     * `<frame>` IS `<iframe>` WITH A SHORTER NAME, and the list named only
     * the long one. `<frameset>` replaces the document's body outright, so
     * it is a defacement of the whole page on top of being a loader.
     *
     * `<plaintext>` has no closing tag by definition: everything after it
     * is raw text, so one of them destroys the rest of a seller's page and
     * nothing can undo it.
     *
     * `<link>` fetches — a stylesheet, an import, a prefetch — which is the
     * one thing this function exists to stop an uploaded file doing.
     *
     * `<applet>` is dead in every browser; removed with the others because
     * a list that is right except for the dead ones is a list people stop
     * reading.
     */
    out = out.replace(/<\/?frameset\b[^>]*>/gi, '');
    out = out.replace(/<\/?frame\b[^>]*\/?>/gi, '');
    out = out.replace(/<\/?plaintext\b[^>]*>/gi, '');
    out = out.replace(/<\/?link\b[^>]*\/?>/gi, '');
    out = out.replace(/<applet\b[\s\S]*?<\/applet\s*>/gi, '');
    out = out.replace(/<\/?applet\b[^>]*\/?>/gi, '');
    // meta refresh / meta with http-equiv
    out = out.replace(/<meta\b[^>]*http-equiv\b[^>]*>/gi, '');
    /*
     * AND `<meta name="referrer">`, which is not an http-equiv and so was
     * not matched. The raw route sends `Referrer-Policy: no-referrer` as a
     * header; a meta referrer in the document OVERRIDES it, and
     * `unsafe-url` then sends the full URL of the seller's page to every
     * third party the page touches.
     */
    out = out.replace(/<meta\b[^>]*\sname\s*=\s*["']?referrer\b[^>]*>/gi, '');
  }

  // 3) Strip ALL inline event handlers (on*).
  //    An attribute starts after ANY separator an HTML parser accepts, not
  //    only whitespace: `<svg/onload=…>` and `<img src="x"onerror=…>` are
  //    both real handlers, and matching `\son…` alone let them through.
  //    Repeated until nothing changes, so removing one handler cannot splice
  //    two fragments into a new one.
  for (let before = ''; before !== out; ) {
    before = out;
    out = out.replace(/([\s/"'])on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
  }

  // 4) Neutralize dangerous URL schemes in any attribute
  //    (javascript:, vbscript:, data:text/html — incl. encoded variants)
  const dangerousUrl = /(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a\s*:\s*t\s*e\s*x\s*t\s*\/\s*h\s*t\s*m\s*l)/i;
  out = out.replace(/(\w+\s*=\s*)(["']?)([^"'>]*)/gi, (m, attr: string, q: string, val: string) => {
    // The pattern tolerates whitespace BETWEEN the letters, which is the
    // old trick. It does not tolerate the letters being written as
    // character references, which is the other one — and a browser decodes
    // those before it reads the scheme. MEASURED: `&#106;avascript:alert(1)`
    // and `&#x6a;avascript:alert(1)` both came back untouched in an `href`.
    if (dangerousUrl.test(decodeCharRefs(val))) return `${attr}${q}#`;
    return m;
  });
  // href/src/action with javascript: written without quotes
  out = out.replace(/(href|src|action|formaction)\s*=\s*(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a\s*:\s*t\s*e\s*x\s*t\s*\/\s*h\s*t\s*m\s*l)[^>\s]*/gi, '$1="#"');

  /*
   * 5) Forms may exist — the trusted Zaki order form is rendered by the app
   *    outside this iframe and never relies on an uploaded one — so what is
   *    stripped is the submit TARGET, not the form.
   *
   *    `formaction` WAS MISSED. It sits on the button, not the form, and it
   *    overrides the form's action when that button submits — so stripping
   *    `action` alone left the hijack intact one tag down. The comment here
   *    already claimed to remove «action/submit hijacking vectors»; this is
   *    the other half of that sentence.
   */
  out = out.replace(/<form\b([^>]*)>/gi, (m, attrs: string) => `<form${attrs.replace(/\saction\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')}>`);
  out = out.replace(/\sformaction\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // 6) style attributes with expression()/javascript: are dead in modern
  //    browsers, stripped anyway for depth:
  out = out.replace(/\sstyle\s*=\s*("([^"]*)")/gi, (m, q: string, val: string) =>
    /expression\s*\(|javascript\s*:|@import/i.test(val) ? ' style=""' : m
  );

  /*
   * 7) AND A `<style>` BLOCK IS CSS, so it is held to the CSS rules.
   *
   * The header above says «CSS is stripped of expression()/behavior/@import
   * /javascript: vectors», and step 6 did that for the style ATTRIBUTE
   * only. A `<style>` block in the uploaded HTML went through untouched,
   * while the very same declarations in the page's CSS field were cleaned
   * by `sanitizeLandingCss`. One rule, enforced in one of its two places.
   *
   * MEASURED: `<style>@import url("https://evil/x.css")</style>` survived
   * here and was stripped there.
   */
  out = out.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style\b[^>]*>)/gi,
    (_m, open: string, css: string, close: string) => `${open}${sanitizeLandingCss(css)}${close}`
  );

  return out;
}

/** Sanitize untrusted landing CSS. Returns cleaned CSS string. */
export function sanitizeLandingCss(css: string): string {
  let out = css ?? '';
  /*
   * expression(), behavior, -moz-binding (old IE vectors, dead but stripped).
   *
   * ONE LEVEL OF NESTING, because `[^)]*` stopped at the FIRST `)` — which
   * in `expression(alert(1))` is the inner one. MEASURED: the output was
   * `a{width:)}` — the vector removed and a stray bracket left behind, so
   * the declaration after it was swallowed by a parser reading unbalanced
   * CSS. A sanitizer that leaves broken syntax breaks pages it approved.
   */
  out = out.replace(/expression\s*\((?:[^()]|\([^()]*\))*\)/gi, '');
  out = out.replace(/behavior\s*:[^;}]+;?/gi, '');
  out = out.replace(/-moz-binding\s*:[^;}]+;?/gi, '');
  // @import can fetch remote CSS (and old-IE javascript: URLs)
  out = out.replace(/@import[^;]+;?/gi, '');
  // javascript: / data:text/html URLs in url(...) — one level of nesting,
  // for the same reason as `expression` above: `url(javascript:alert(1))`
  // left `url("#"))` and an unbalanced bracket in the sheet.
  out = out.replace(
    /url\s*\(\s*(['"]?)\s*(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a\s*:\s*t\s*e\s*x\s*t\s*\/\s*h\s*t\s*m\s*l)(?:[^()]|\([^()]*\))*\)/gi,
    'url("#")'
  );
  // comments can be used to split tokens in old filters — normalize
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  /*
   * A STYLE ELEMENT ENDS AT THE FIRST END TAG, WHATEVER CSS IS IN THE MIDDLE.
   *
   * This CSS goes into a style element twice — the raw route wraps the
   * page's CSS field in one, and a style block of the uploaded HTML is held
   * to this function — and the HTML parser looks for the end tag before it
   * reads one declaration. MEASURED: `a{}</style><script>…</script>` came
   * back byte for byte, and the raw route put it in the document as a real
   * script tag AFTER the sanitizer had run, because the CSS field is
   * injected last.
   *
   * The same CSS with the slash escaped is no longer an end tag. ONLY the
   * `</` before the word is touched: a bare `<` stays, so a media query
   * written `(width<600px)` keeps working. It runs LAST, after the comments
   * are gone, because a tag split by a comment is a tag the moment the
   * comment is removed.
   */
  out = out.replace(/<\/(?=\s*style)/gi, '<\\/');
  return out;
}

/** Validate + normalize page settings JSON from the editor. */
export function parseLandingSettings(raw: unknown): LandingPageSettings | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const out: LandingPageSettings = {};
  if (s.width === 'full' || s.width === 'contained') out.width = s.width;
  if (typeof s.maxWidth === 'number' && Number.isFinite(s.maxWidth) && s.maxWidth >= 320 && s.maxWidth <= 1920) {
    out.maxWidth = Math.round(s.maxWidth);
  }
  if (typeof s.background === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s.background)) out.background = s.background;
  if (s.direction === 'rtl' || s.direction === 'ltr') out.direction = s.direction;
  if (typeof s.fontFamily === 'string' && /^[\w\s,'"\-]{0,120}$/.test(s.fontFamily)) out.fontFamily = s.fontFamily.slice(0, 120);
  return out;
}

/** Whitelisted dynamic variables available in landing HTML. */
export const LANDING_VARIABLES = [
  'product.name',
  'product.nameEn',
  'product.image',
  'product.description',
  'product.price',
] as const;

function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Replace whitelisted {{variable}} placeholders with server-side product
 * values (HTML-escaped). Unknown placeholders are left untouched. Values
 * always come from the DB — never from the request.
 */
export function applyLandingVariables(
  html: string,
  data: { name?: string | null; nameEn?: string | null; image?: string | null; description?: string | null; price?: number | null }
): string {
  if (!html) return html;
  const map: Record<string, string> = {
    'product.name': escapeHtml(data.name ?? ''),
    'product.nameEn': escapeHtml(data.nameEn ?? ''),
    'product.image': escapeHtml(data.image ?? ''),
    'product.description': escapeHtml(data.description ?? ''),
    'product.price': escapeHtml(data.price != null ? String(data.price) : ''),
  };
  return html.replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (m, key: string) => (key in map ? map[key] : m));
}

/**
 * PUT THE PAGE'S OWN STYLES INTO ITS DOCUMENT.
 *
 * `base` (the page settings) goes straight after the opening `<head>` and
 * `custom` (the seller's CSS) just before `</head>`, so the base styles are
 * the first word in the cascade and the seller's CSS the last.
 *
 * THE REPLACEMENT IS A FUNCTION, NEVER A STRING. `String.replace` reads
 * `$'`, `$&` and `$1` in a replacement string, and the CSS is a seller's:
 * `content:"$'"` made the old call paste the rest of the document into the
 * middle of the stylesheet. A function's return value is taken literally.
 *
 * The pattern is the opening `<head>` tag and not `<header>`. A document
 * with no head gets both at its front, as it always did; one with an
 * opening tag and no closing one gets the seller's CSS right after the base.
 */
const HEAD_OPEN = /<head(\s[^>]*)?>/i;
const HEAD_CLOSE = /<\/head>/i;

export function injectPageStyles(html: string, base: string, custom: string): string {
  if (!base && !custom) return html;
  const opened = HEAD_OPEN.test(html);
  const closed = HEAD_CLOSE.test(html);
  if (!opened && !closed) return base + custom + html;
  let out = html;
  if (opened) out = out.replace(HEAD_OPEN, (open) => open + base + (closed ? '' : custom));
  else out = base + out;
  if (closed) out = out.replace(HEAD_CLOSE, () => custom + '</head>');
  return out;
}
