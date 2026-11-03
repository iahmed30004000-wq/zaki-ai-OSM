import { SELLING_PAGE_HEADERS } from '@/lib/csp';
import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { hostSite, inHostScope } from '@/lib/landing-domain';
import { countRedirectHit, redirectFor } from '@/lib/store-redirects';
import { cachedLandingPath, isCachedLandingPath } from '@/lib/landing-cache-path';
import {
  PREVIEW_COOKIE,
  PREVIEW_REFUSAL,
  PREVIEW_REFUSAL_CODE,
  PREVIEW_STAMP_HEADER,
  cookieFrom,
  previewStamp,
  previewVerdict,
  verifyPreviewToken,
} from '@/lib/preview-mode';

let cachedJwtSecret: Uint8Array | null = null;
function getJwtSecret(): Uint8Array {
  if (!cachedJwtSecret) {
    const secret = process.env.JWT_SECRET;
    if (!secret && process.env.NODE_ENV === 'production') {
      throw new Error('SECURITY: JWT_SECRET environment variable is required in production.');
    }
    // Development-only fallback, never used in production.
    cachedJwtSecret = new TextEncoder().encode(secret || 'development_only_insecure_jwt_secret_key_0000');
  }
  return cachedJwtSecret;
}

const COOKIE_NAME = 'salesflow_session';

// Public by design: the login flow, landing pages, and storefronts. Each
// carries its own guards — a storefront serves only an ENABLED one, and a
// landing page only a PUBLISHED one.
//
// /fonts is the app's own font folder. The faces under it are declared by
// BLOCK_CSS on every public block page, so a shopper — who has no session —
// must be able to fetch them. Their extension (.woff2) is not in the
// matcher's static-asset list, so without this the request reached the
// session check and every public page was served a 302 to /login instead of
// its font.
const PUBLIC_PATHS = ['/login', '/register', '/forgot-password', '/reset-password', '/lp', '/s', '/fonts'];

/**
 * Edge pass: session presence and account state only.
 *
 * Route permissions are NOT decided here. Every screen is guarded on the
 * server by src/lib/page-guard.ts against the route registry (404 outside
 * the contract, 403 without the permission), and every API re-checks the
 * same permission. The edge never sees the permission engine's DB state.
 */

function redirectTo(req: Request, path: string) {
  const url = new URL(req.url);
  url.pathname = path;
  url.search = '';
  return NextResponse.redirect(url);
}

/**
 * Origin validation for mutating API requests (CSRF defense-in-depth).
 *
 * Trade-off (documented): browsers attach an Origin header to cross-site
 * mutations and to same-origin POST/PUT/PATCH/DELETE fetches, so a forged
 * cross-site request is always rejected. Requests WITHOUT an Origin header
 * (server-to-server clients, curl) pass through — they cannot be produced
 * by a victim's browser on a cross-site form/image submission.
 *
 * - ALLOWED_ORIGINS set (comma-separated) → Origin must be same-origin or listed.
 * - ALLOWED_ORIGINS empty (default) → same-origin only.
 */
function validateApiOrigin(req: Request): NextResponse | null {
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (!mutating) return null;

  const origin = req.headers.get('origin');
  if (!origin) return null; // non-browser / server-to-server client

  const host = req.headers.get('host');
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }

  const sameOrigin = !!originHost && !!host && originHost === host;
  if (sameOrigin) return null;

  const allowedList = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const inList =
    allowedList.length > 0 &&
    allowedList.some((allowed) => {
      try {
        return new URL(allowed).host === originHost;
      } catch {
        return allowed === origin;
      }
    });

  if (!inList) {
    return NextResponse.json({ errorAr: 'طلب غير موثوق المصدر' }, { status: 403 });
  }
  return null;
}

/**
 * A rewrite onto a selling page, answered with the selling page's headers. next.config's header rules match the path
 * the browser ASKED for; a rewritten request would otherwise wear the dashboard's shut policy, which refuses the page's
 * fonts and pixels.
 */
function sellingRewrite(req: Request, pathname: string) {
  const target = new URL(req.url);
  target.pathname = pathname;
  const res = NextResponse.rewrite(target);
  for (const h of SELLING_PAGE_HEADERS) res.headers.set(h.key, h.value);
  return res;
}

/**
 * «عاين كـ» — THE OWNER'S READ-ONLY PREVIEW, ANSWERED BEFORE ANY HANDLER RUNS (src/lib/preview-mode.ts).
 *
 * Only a preview cookie that verifies AND binds to this very session counts: signed with the session key, naming
 * the signed-in user as its owner, and carrying the fingerprint of this session cookie. A cookie copied into any
 * other browser binds to nothing and is ignored — which also means it refuses nobody else's writes.
 *
 * While one binds: a write is refused (403, «وضع المعاينة — قراءة بس») unless it is one of the three open doors,
 * and a read is stamped so `getCurrentUser` may answer as the person being previewed.
 */
async function previewGate(req: Request, pathname: string): Promise<{ refusal: NextResponse | null; stamp: string | null }> {
  const none = { refusal: null, stamp: null };
  const cookieHeader = req.headers.get('cookie');
  const previewToken = cookieFrom(cookieHeader, PREVIEW_COOKIE);
  if (!previewToken) return none;
  const sessionToken = cookieFrom(cookieHeader, COOKIE_NAME);
  const claims = await verifyPreviewToken(previewToken, sessionToken, getJwtSecret());
  if (!claims) return none;
  try {
    const { payload } = await jwtVerify(sessionToken!, getJwtSecret());
    if (payload.userId !== claims.ownerId) return none;
  } catch {
    return none;
  }
  const verdict = previewVerdict(req.method, pathname);
  if (verdict === 'refuse') {
    return {
      refusal: NextResponse.json({ error: PREVIEW_REFUSAL, errorAr: PREVIEW_REFUSAL, code: PREVIEW_REFUSAL_CODE }, { status: 403 }),
      stamp: null,
    };
  }
  return { refusal: null, stamp: verdict === 'stamp' ? await previewStamp(previewToken, getJwtSecret()) : null };
}

/**
 * On to the app — carrying the preview stamp when this is a preview read, and never a stamp the browser sent.
 * (A forged one would fail its HMAC anyway; it is dropped so nothing downstream ever sees one.)
 */
function forward(req: Request, stamp: string | null) {
  if (!stamp && !req.headers.has(PREVIEW_STAMP_HEADER)) return NextResponse.next();
  const headers = new Headers(req.headers);
  headers.delete(PREVIEW_STAMP_HEADER);
  if (stamp) headers.set(PREVIEW_STAMP_HEADER, stamp);
  return NextResponse.next({ request: { headers } });
}

export async function proxy(req: Request) {
  const url = new URL(req.url);
  const { pathname } = url;

  // ── The cached landing page (`landing-cache-path.ts`) ──
  // Its internal route is reached only through the rewrite below; asked for by name it does not exist, so nobody can
  // reach a page by a second address that no count or redirect knows about.
  if (isCachedLandingPath(pathname)) return new NextResponse('Not found', { status: 404 });

  // ── «عاين كـ»: no write while the owner previews somebody (see previewGate) ──
  const preview = await previewGate(req, pathname);
  if (preview.refusal) return preview.refusal;

  // ── A seller's own domain ──
  //
  // A hostname pointed here in DNS serves one published landing page or one
  // enabled storefront. The rewrite is invisible: the customer's address bar
  // keeps the seller's domain, and the page underneath is the same public
  // route as ever, with the same guards.
  //
  // A host that belongs to nothing falls straight through, so the app's own
  // hostname costs one cached lookup per minute and nothing else. API paths
  // are left alone: the order the page posts must reach the real endpoint.
  //
  // A storefront has real paths under it (a product page), so the rewrite
  // carries the rest of the path along — only the root is replaced.
  // The app's own public files (/fonts/…: the self-hosted faces a page may
  // use) are the same on every host; rewriting them under the page's path
  // made them 404 on a seller's domain.
  // ── An old address that still arrives ──
  //
  // A slug renamed while an advertisement was running leaves every
  // already-paid click landing on a 404. The seller's accepted redirects
  // forward them instead. Only the two public spaces are consulted, and
  // only for a GET: a redirect must never swallow an order being posted.
  //
  // Suggestions do not forward — redirectFor filters them — so a rename
  // never silently changes where a live address goes.
  if ((pathname.startsWith('/lp/') || pathname.startsWith('/s/')) && req.method === 'GET') {
    const hop = await redirectFor(pathname);
    if (hop) {
      countRedirectHit(hop.id); // best-effort; the customer never waits on it
      const target = new URL(req.url);
      if (hop.to.startsWith('/')) {
        target.pathname = hop.to;
      } else {
        // An absolute destination replaces the address entirely, but the
        // campaign code the ad appended is what tells the shop which ad
        // this sale came from, so the query is carried across.
        const away = new URL(hop.to);
        for (const [k, v] of target.searchParams) if (!away.searchParams.has(k)) away.searchParams.set(k, v);
        return NextResponse.redirect(away, hop.kind);
      }
      return NextResponse.redirect(target, hop.kind);
    }
  }

  if (!pathname.startsWith('/api/') && !pathname.startsWith('/_next/') && !pathname.startsWith('/fonts/')) {
    const site = await hostSite(req.headers.get('host'));
    if (site) {
      // The public paths themselves (/lp/…, /s/…) pass through untouched —
      // but only this host's own. The public space is shared by every
      // company, and a seller's domain answered for all of it: shop-a.com/
      // lp/<any company's page> rendered that page under seller A's name.
      if (pathname.startsWith('/lp/') || pathname.startsWith('/s/')) {
        if (!inHostScope(site, pathname)) return new NextResponse('Not found', { status: 404 });
        const cached = req.method === 'GET' ? cachedLandingPath(pathname, url.searchParams) : null;
        return cached ? sellingRewrite(req, cached) : NextResponse.next();
      }
      // The seller's domain root IS their landing page: answered from the cache when the switch is on, like /lp/<slug>.
      const cachedRoot = pathname === '/' && req.method === 'GET' ? cachedLandingPath(site.path, url.searchParams) : null;
      if (cachedRoot) return sellingRewrite(req, cachedRoot);
      const target = new URL(req.url);
      target.pathname = pathname === '/' ? site.path : `${site.path}${pathname}`;
      // The page underneath is a selling page, but next.config's header
      // rules matched THIS path ("/", "/p/…"), which is the dashboard's —
      // the shut policy that refuses the page's fonts, its pixels and the
      // dashboard's own preview frame. Answer with the selling page's.
      const res = NextResponse.rewrite(target);
      for (const h of SELLING_PAGE_HEADERS) res.headers.set(h.key, h.value);
      return res;
    }
  }

  // API routes: origin validation on mutations; auth lives in each handler.
  // Public endpoints (landing pages, webhooks) are intentionally included —
  // they carry their own guards and the origin check is method-scoped.
  if (pathname.startsWith('/api/')) {
    const originError = validateApiOrigin(req);
    if (originError) return originError;
    return forward(req, preview.stamp);
  }

  // A visit to a landing page, answered from the cache when the owner has turned it on. Only a GET — an order is never
  // a page view — and never a preview (`cachedLandingPath` says no to `?p=`).
  if (req.method === 'GET') {
    const cached = cachedLandingPath(pathname, url.searchParams);
    if (cached) return sellingRewrite(req, cached);
  }

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return forward(req, preview.stamp);
  }

  // Read session token from the HTTP-only cookie (never from client storage)
  const cookieHeader = req.headers.get('cookie') || '';
  const tokenMatch = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  const token = tokenMatch?.split('=')[1];

  if (!token) {
    return redirectTo(req, '/login');
  }

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, getJwtSecret()));
  } catch {
    return redirectTo(req, '/login');
  }

  const status = payload.status as string;

  if (status === 'SUSPENDED' || status === 'DISABLED') {
    return redirectTo(req, '/login?suspended=1');
  }

  if (status === 'PENDING') {
    if (pathname === '/pending' || pathname === '/admin/profile') {
      return forward(req, preview.stamp);
    }
    return redirectTo(req, '/pending');
  }

  return forward(req, preview.stamp);
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals and static assets. Screens resolve
     * through the route registry, so no path list is maintained here.
     */
    /*
     * The installable app's own files are public static files like any
     * other, and were the only two whose extensions were missing here: the
     * manifest was redirected to /login, so the app could not be installed
     * at all, and the offline page the worker falls back to was redirected
     * to a page it cannot reach while offline.
     */
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|offline.html|icons/|.*\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|map|webmanifest|html)$).*)',
  ],
};
