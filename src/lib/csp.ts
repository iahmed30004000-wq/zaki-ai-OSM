/**
 * THE CONTENT SECURITY POLICY OF A SELLING PAGE.
 *
 * One definition, read by next.config.ts (for /lp and /s paths) and by the
 * proxy (for a seller's own domain, whose path is "/" and so never matches
 * a path rule). No imports: next.config.ts loads this file before the app
 * exists.
 *
 * WHY THE PIXEL ORIGINS ARE HERE AND NOWHERE ELSE. The tracking engine
 * loads Meta's, TikTok's, Snapchat's and Google's own scripts, and until
 * this list existed every page sent `script-src 'self'` — so the browser
 * refused all four and not one browser pixel ever fired. They are allowed
 * on selling pages only: the dashboard keeps its shut policy, because an
 * admin screen has no business loading an ad network's code.
 */

/** Script hosts of the four pixel loaders in tracking-platforms.ts. */
export const PIXEL_SCRIPT_ORIGINS = [
  'https://connect.facebook.net',
  'https://analytics.tiktok.com',
  'https://sc-static.net',
  'https://www.googletagmanager.com',
] as const;

/** Where those scripts send their events. Images are already allowed (https:). */
export const PIXEL_CONNECT_ORIGINS = [
  'https://www.facebook.com',
  'https://connect.facebook.net',
  'https://analytics.tiktok.com',
  'https://*.tiktok.com',
  'https://tr.snapchat.com',
  'https://*.snapchat.com',
  'https://www.googletagmanager.com',
  'https://www.google-analytics.com',
  'https://*.google-analytics.com',
  'https://*.analytics.google.com',
  'https://www.google.com',
  'https://googleads.g.doubleclick.net',
] as const;

/** Frames the Google Ads tag opens for remarketing. */
export const PIXEL_FRAME_ORIGINS = ['https://td.doubleclick.net', 'https://www.googletagmanager.com'] as const;

/**
 * A landing page or a storefront page.
 *
 * `frame-ancestors 'self'`: the dashboard previews these pages in an
 * iframe; every other site is still refused. Fonts come from Google Fonts,
 * which the theme picker offers.
 */
export const SELLING_PAGE_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${PIXEL_SCRIPT_ORIGINS.join(' ')}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  `connect-src 'self' ${PIXEL_CONNECT_ORIGINS.join(' ')}`,
  `frame-src 'self' ${PIXEL_FRAME_ORIGINS.join(' ')}`,
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** Every header a selling page answers with, beyond the site-wide ones. */
export const SELLING_PAGE_HEADERS: { key: string; value: string }[] = [
  { key: 'Content-Security-Policy', value: SELLING_PAGE_CSP },
  // The catch-all sends DENY; a selling page must allow the same-origin
  // preview frame, or the older header wins in browsers that honour both.
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
];

/**
 * THE UPLOADED HTML OF A LANDING PAGE (/lp/<slug>/raw).
 *
 * `sandbox` without allow-same-origin puts the document in an opaque origin
 * EVEN WHEN THE URL IS OPENED IN A TAB — so uploaded HTML can never reach
 * the session cookie, storage, or a credentialed call to our API.
 *
 * It lives here, and is sent from next.config, because that is the header
 * that reaches the browser: Next writes the config's headers first and a
 * route handler's same-named header is then dropped. The route sent this
 * policy and the browser never received it — it received the config's,
 * which had no sandbox.
 *
 * NO `allow-forms`. The order form on a page is OURS and is drawn outside
 * this frame; a form inside the uploaded file can only be a form that posts
 * a visitor's phone number and address somewhere the seller (or whoever
 * edited their file) chose. Without the token the browser refuses to submit
 * it at all — and `form-action 'self'` is kept beside it, so the policy
 * does not depend on one directive. (The frame's own `sandbox` attribute,
 * in LandingPageView, still names allow-forms; the header's sandbox is
 * added to it, never subtracted, so the header decides.)
 */
export const RAW_HTML_CSP =
  "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data: https:; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; sandbox allow-scripts allow-popups allow-modals";

export const RAW_HTML_HEADERS: { key: string; value: string }[] = [
  { key: 'Content-Security-Policy', value: RAW_HTML_CSP },
  // Framed by our own landing page only.
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
];

/**
 * A STORED FILE SERVED TO THE PUBLIC (/api/public/media/…).
 *
 * The bytes are a seller's upload. Served at our own origin, so a file that
 * turns out not to be the image its type claims must still be inert: nothing
 * it contains may load, and `sandbox` (no allow-same-origin) denies it this
 * origin if it is ever opened in a tab rather than drawn in an <img>.
 *
 * Sent from next.config for the same reason as the raw HTML above — the
 * route's own header is dropped in favour of the catch-all's, so the route
 * sent this and the browser received the dashboard's policy instead.
 */
export const PUBLIC_MEDIA_HEADERS: { key: string; value: string }[] = [
  { key: 'Content-Security-Policy', value: "default-src 'none'; sandbox" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // A shopper's page on a seller's own domain draws these images, so the
  // catch-all's DENY cannot apply; nothing may frame them cross-site either.
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
];
