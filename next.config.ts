import type { NextConfig } from 'next';
import { PUBLIC_MEDIA_HEADERS, RAW_HTML_HEADERS, SELLING_PAGE_HEADERS } from './src/lib/csp';

// HSTS is only sent in production so local dev over http stays clean.
const isProduction = process.env.NODE_ENV === 'production';

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // `camera=(self)`, not `camera=()`.
  //
  // The empty list means NOBODY may use the camera — including this app.
  // The barcode scanner (src/components/scan/ScanButton.tsx) therefore
  // failed with NotAllowedError on every device, before the browser ever
  // asked the person for permission, and no component test could see it:
  // a test mocks getUserMedia, and this is the header above it.
  //
  // The microphone, the location and the payment API stay shut. Nothing in
  // the system asks for them, and a warehouse phone should not be able to.
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), payment=()' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  // CSP: 'unsafe-inline' styles required by Tailwind; img allows data/blob thumbnails
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // The theme and design screens PREVIEW the fonts a seller may pick
      // for their shop, which means fetching the sheet those fonts come
      // from. Without these two the picker offered twenty Arabic faces and
      // rendered every one of them in the default.
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' https://openrouter.ai",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
  // No includeSubDomains: this header also reaches sellers' own domains —
  // every script, image and order post a page on shop.com loads from this
  // app carries it — and there it would pin every subdomain of the seller's
  // domain (their mail, their other sites) to HTTPS for a year.
  ...(isProduction ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }] : []),
];

// The uploaded HTML of a landing page (/lp/:slug/raw) gets its sandboxing
// policy from HERE, not from its route: Next writes these headers first and
// drops a route's same-named header, so the sandbox the route sent never
// reached a browser. Defined in src/lib/csp.ts.

// Selling pages — a landing page and a storefront — have their own policy,
// defined once in src/lib/csp.ts because the proxy sends the same one for a
// seller's own domain. It adds exactly what such a page needs over the
// catch-all: the Google Fonts the theme offers, the four pixel networks the
// tracking engine loads, and `frame-ancestors 'self'` so the dashboard can
// preview the page in an iframe ('none' made the preview a blank box with
// nothing in any log to explain it). The dashboard keeps the shut CSP above.

// The block designer renders the landing page INSIDE the dashboard, so it
// needs the same font stylesheet the public page is allowed to load. Without
// it the seller picks a font, the browser refuses the stylesheet, and the
// preview silently keeps the old face — the choice appears to do nothing
// while the published page changes. One screen, one added source: the rest
// of the dashboard keeps the shut CSP above.
const lpEditorHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' https://openrouter.ai",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  /**
   * WHERE THE BUILD IS WRITTEN — `.next`, unless something says otherwise.
   *
   * A dev server holds `.next` open on Windows, so `next build` beside a
   * running `next dev` fails on a locked file. The performance budgets this
   * project is held to («JavaScript أقل من 120 كيلوبايت للصفحة») can only
   * be measured against a production build, and measuring them must not
   * mean stopping the server somebody is working against.
   *
   * Unset in every normal build and in production: the default is the
   * default.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',
  /**
   * WHERE TURBOPACK IS ALLOWED TO LOOK — the project, unless something says
   * otherwise.
   *
   * The same shape and the same reason as `distDir` above, for the same
   * situation: verifying a change must not mean disturbing the checkout
   * somebody else is working in.
   *
   * Work on this repository happens in git worktrees under
   * `.claude/worktrees/`, and a worktree has no `node_modules` of its own —
   * it shares the main checkout's, one directory tree up. Node's own
   * resolution walks up and finds it, which is why `tsc` and `vitest` run
   * in a worktree without anything special. Turbopack does not: it resolves
   * only inside the project root it detects from the nearest lockfile, and
   * a worktree has its own lockfile. So `next dev` and `next build` in a
   * worktree stop at «Could not find the Next.js package», and a junction
   * to the real one is refused outright — «Symlink [project]/node_modules
   * is invalid, it points out of the filesystem root».
   *
   * Pointing the root at the directory that contains BOTH the worktree and
   * the real `node_modules` is the answer the Turbopack documentation gives
   * for linked dependencies, and it is the only one that does not involve a
   * second copy of 400 packages per worktree.
   *
   * Unset in every normal build and in production: the default is the
   * default, and nothing here changes what is shipped.
   */
  ...(process.env.NEXT_TURBOPACK_ROOT ? { turbopack: { root: process.env.NEXT_TURBOPACK_ROOT } } : {}),
  output: 'standalone',
  serverExternalPackages: ['sharp'],
  // Do not advertise the framework version
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // After the catch-all so each overrides the CSP for its own route.
      { source: '/lp/:slug', headers: SELLING_PAGE_HEADERS },
      // A design's full preview (`/lp/design-preview/<id>`) is two segments deep, so `/lp/:slug` does not reach it; the
      // library shows it in a frame on the dashboard, which the catch-all's `frame-ancestors 'none'` would refuse.
      { source: '/lp/design-preview/:design', headers: SELLING_PAGE_HEADERS },
      { source: '/s/:path*', headers: SELLING_PAGE_HEADERS },
      { source: '/lp/:slug/raw', headers: RAW_HTML_HEADERS },
      { source: '/api/public/media/:path*', headers: PUBLIC_MEDIA_HEADERS },
      { source: '/growth/landing-pages/:id/editor', headers: lpEditorHeaders },
    ];
  },
  async redirects() {
    return [
      // The tracking screen's old address, kept alive for bookmarks and for
      // links already pasted into notes and chats.
      { source: '/settings/pixels', destination: '/settings/tracking', permanent: true },
      // «استلام بضاعة جاهزة» is a button on each balances card now, not a
      // screen. The old address — and `?product=<id>` on it, which Next carries
      // across a redirect — keeps landing on the dialog it used to open.
      { source: '/inventory/receiving', destination: '/inventory/balances', permanent: true },
      // «الطلبات المؤجلة» and «استرجاع الملغى» are the two tabs of «المتابعة». An agent who
      // arrives at the first is sent on, by the page, to the tab of «طلباتي» that is hers.
      { source: '/confirmation/postponed', destination: '/confirmation/follow-up', permanent: true },
      { source: '/confirmation/winback', destination: '/confirmation/follow-up?tab=winback', permanent: true },
      // «إعدادات واتساب» and «إعدادات تلجرام» are the two cards of «الربط».
      { source: '/settings/whatsapp', destination: '/settings/links#whatsapp', permanent: true },
      { source: '/settings/telegram', destination: '/settings/links#telegram', permanent: true },
      // The single-product shop is one card on /store now: its old address
      // moves bookmarks and pasted links along permanently.
      { source: '/store/single-product', destination: '/store', permanent: true },

      /*
       * THE EIGHT STOREFRONT SCREENS THAT BECAME THREE TABS.
       *
       * Ten menu entries for one shop is what the owner called «معجّق …
       * بتضيع»; the entries are gone and the screens are not — each one
       * renders as a panel of `/store?tab=…&sec=…`. Every old address is
       * a bookmark somebody has, a link in a chat, and a line in a note,
       * so none of them may ever answer 404.
       *
       * `permanent: true` is a 308: a browser that followed it once stops
       * asking, which is the point — the old address is not coming back.
       *
       * These are written out rather than generated from
       * `src/lib/store-admin.ts` because this file is read at build time
       * by the Next config loader; `a-shop-is-two-entries.test.ts` holds
       * the two lists in step instead, and fails the moment they differ.
       */
      { source: '/store/design', destination: '/store?tab=front&sec=home', permanent: true },
      { source: '/store/themes', destination: '/store?tab=front&sec=look', permanent: true },
      { source: '/store/pages', destination: '/store?tab=content&sec=pages', permanent: true },
      /*
       * «الآراء» landed on main as a NINTH entry while this was being
       * built. It is a panel of «المحتوى» now, for the reason its own
       * registry comment gave — «what the shop SAYS» — and the
       * notification that links to the old address still arrives.
       */
      { source: '/store/reviews', destination: '/store?tab=content&sec=reviews', permanent: true },
      { source: '/store/menus', destination: '/store?tab=content&sec=menus', permanent: true },
      { source: '/store/search', destination: '/store?tab=content&sec=search', permanent: true },
      { source: '/store/languages', destination: '/store?tab=content&sec=languages', permanent: true },
      { source: '/store/domain', destination: '/store?tab=address&sec=domain', permanent: true },
      { source: '/store/routes', destination: '/store?tab=address&sec=routes', permanent: true },
    ];
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  experimental: {
    // forbidden() -> app/forbidden.tsx with a real 403 for pages the role may not open
    authInterrupts: true,
  },
};

export default nextConfig;
