import { db } from '@/lib/db';
import { deviceClassOf, isPrefetch, recordBrowserView, recordLandingView } from '@/lib/landing-views';
import { landingCacheOn } from '@/lib/landing-cache-path';
import { resolveCampaign } from '@/lib/campaigns-server';
import { UNKNOWN_IP, getClientIp, rateLimit } from '@/lib/rate-limit';

/**
 * POST /api/public/lp-view — «الصفحة انفتحت عند الزائر».
 *
 * Sent once by a landing page as it opens in a visitor's browser (`BrowserVisit`), with `navigator.sendBeacon`. It is
 * the count a CACHED page will rely on, run for a week beside the server's count (`recordLandingView`) so the two can be
 * compared before the switch. It always writes `landing_page_browser_views`; the server's rows and the lifetime
 * `viewsCount` only for a cached page's visit, below.
 *
 * The same rules as the server's count, and the two it could not have: a link-preview crawler is not a visitor
 * (`deviceClassOf`), and neither is a request made AHEAD of a visit (Meta's preload, a prefetch — `isPrefetch`). Only a
 * published page counts, so a preview or an unpublished draft never does.
 *
 * ONCE THE CACHE IS ON, THE CACHED PAGE'S BEACON IS THE VISIT. A cached page is not built per visit, so the server
 * does not count it; its beacon carries `o:1` and — only while the owner's switch (`LP_PAGE_CACHE=1`) is on — is also
 * written where the server's count goes (`viewsCount` and `landing_page_views`), so every screen that reads visits
 * goes on reading them. A beacon from a page built per request (the switch off, a store's front) never does: the
 * server already counted that visit, and one visit is never counted twice.
 *
 * Always 204 and never a reason: a beacon has nobody to read an answer, and a page that cannot be counted must never
 * look broken.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9_-]{1,40}$/;
const done = () => new Response(null, { status: 204 });
/** Visits one page may record in a minute when the visitor's address is unknown: 20 a second, far above a busy advert hour. */
const PAGE_CEILING_PER_MINUTE = 1200;

export async function POST(req: Request) {
  try {
    if (isPrefetch(req.headers)) return done();
    const device = deviceClassOf(req.headers.get('user-agent'));
    if (!device) return done();

    // `sendBeacon` posts a string as text/plain; read the body as text whatever it says it is.
    const raw = (await req.text()).slice(0, 500);
    let body: { p?: unknown; c?: unknown; o?: unknown } = {};
    try {
      body = JSON.parse(raw);
    } catch {
      return done();
    }
    const pageId = typeof body.p === 'string' && UUID.test(body.p) ? body.p : null;
    if (!pageId) return done();
    const code = typeof body.c === 'string' && CODE.test(body.c) ? body.c : null;

    // A flood from one address is not a crowd. Behind no trusted proxy every visitor shares one address, so a per-address
    // limit would stop counting the busy hour an advert brings: there the limit is per PAGE and far looser (A7). It is
    // only a ceiling against a script writing rows without end, and a beacon over it is dropped silently like any other.
    const ip = getClientIp(req);
    if (ip === UNKNOWN_IP) {
      if (!rateLimit(`lp_view:page:${pageId}`, PAGE_CEILING_PER_MINUTE, 60_000).allowed) return done();
    } else if (!rateLimit(`lp_view:${ip}:${pageId}`, 60, 60_000).allowed) {
      return done();
    }

    const page = await db.landingPage.findFirst({
      where: { id: pageId, isPublished: true },
      select: { id: true, companyId: true, storeId: true },
    });
    if (!page) return done();

    const campaignId = code && page.storeId ? await resolveCampaign(page.companyId, page.storeId, code) : null;
    const view = { companyId: page.companyId, storeId: page.storeId, landingPageId: page.id, campaignId, device };
    await recordBrowserView(view);
    if (body.o === 1 && landingCacheOn()) {
      await db.landingPage.update({ where: { id: page.id }, data: { viewsCount: { increment: 1 } } });
      await recordLandingView(view);
    }
    return done();
  } catch {
    return done();
  }
}
