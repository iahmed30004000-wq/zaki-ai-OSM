import { deviceClassOf } from '@/lib/landing-views';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { LANDING_PAGE_SOURCE } from '@/lib/landing-pages';
import { createPublicOrder, type SellingSurface } from '@/lib/public-order';
import { resolveCampaign } from '@/lib/campaigns-server';
import { checkoutRules, parseStoreTheme } from '@/lib/store-theme';

/**
 * Public order intake from a landing page.
 *
 * This route's whole job is to decide WHICH shop a stranger is standing in
 * front of. Everything after that — validation against the country, the
 * blacklist, the duplicate guard, the customer record, the one cod function,
 * the Order row — lives in createPublicOrder, because a storefront comes
 * into the same shop through a different door, and a second copy of those
 * rules would drift on the day one of them changed.
 */

interface Ctx {
  params: Promise<{ slug: string }>;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

const MAX_BODY_BYTES = 10 * 1024; // 10 KB hard request-size limit

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { slug } = await ctx.params;
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CORS });
    }

    // ─── Rate limiting ───
    const ip = getClientIp(req);
    const rl = rateLimit(`lp_order:${ip}`, 10, 10 * 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `محاولات كثيرة جدًا. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` },
        { status: 429, headers: { ...CORS, 'Retry-After': String(rl.retryAfterSec) } }
      );
    }

    // ─── Request size limit (defense in depth beyond Next's own limits) ───
    const contentLength = parseInt(req.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'البيانات كبيرة جدًا' }, { status: 413, headers: CORS });
    }

    // ─── Origin validation (soft) ───
    // Sandboxed iframes send Origin: null, so an exact match cannot be
    // required; a cross-site origin naming a different host is refused.
    const origin = req.headers.get('origin');
    if (origin && origin !== 'null') {
      try {
        const o = new URL(origin);
        const host = req.headers.get('host');
        if (host && o.host !== host) {
          return NextResponse.json({ error: 'طلب غير مسموح' }, { status: 403, headers: CORS });
        }
      } catch {
        return NextResponse.json({ error: 'طلب غير مسموح' }, { status: 403, headers: CORS });
      }
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400, headers: CORS });
    }

    // ─── Resolve the landing page → company → product (server-side only) ───
    // This comes BEFORE validation: the phone format and the list of cities
    // depend on the country this page sells into.
    const lp = await db.landingPage.findFirst({
      where: { slug, isPublished: true },
      orderBy: { createdAt: 'asc' }, // one resolution for a slug everywhere — the oldest page keeps it
      include: {
        company: { select: { id: true } },
        product: { select: { id: true, basePrice: true, name: true, image: true } },
        store: {
          select: {
            id: true,
            countryId: true,
            country: { select: { code: true, currencyCode: true, orderPrefix: true, minorUnit: true } },
            // The LIVE theme — what the page's form was drawn from — for what its «الدفع» requires. Never the draft.
            theme: true,
          },
        },
      },
    });
    if (!lp) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CORS });

    // Every order must land in a store, and must name a product.
    if (!lp.store || !lp.productId || !lp.product) {
      return NextResponse.json({ error: 'هذه الصفحة لا تقبل الطلبات حاليًا' }, { status: 409, headers: CORS });
    }

    // The campaign that brought this visitor, resolved from the code their
    // link carried. The browser sends a code and never an id: an id taken
    // from a request would let anyone credit another shop's spend.
    const campaignId = await resolveCampaign(
      lp.company.id,
      lp.store.id,
      (raw as { campaign?: unknown } | null)?.campaign
    );

    const surface: SellingSurface = {
      deviceClass: deviceClassOf(req.headers.get('user-agent')),
      companyId: lp.company.id, // server-derived — NEVER from the browser
      store: { id: lp.store.id, countryId: lp.store.countryId, country: lp.store.country },
      // What the store's «الدفع» requires, from its LIVE theme — the same answer the page's form was drawn from.
      checkout: checkoutRules(parseStoreTheme(lp.store.theme)),
      campaignId,
      products: [lp.product],
      landingPage: { id: lp.id, name: lp.name, slug: lp.slug },
      source: LANDING_PAGE_SOURCE,
      dedupeScope: `lp:${lp.id}`,
      notice: {
        title: 'طلب جديد من صفحة هبوط',
        message: (n) => `طلب جديد #${n} من صفحة الهبوط "${lp.name}" (${lp.slug}).`,
      },
    };

    const result = await createPublicOrder(surface, raw);
    if (!result.ok) {
      return NextResponse.json(result.body, {
        status: result.status,
        headers: { ...CORS, ...(result.headers ?? {}) },
      });
    }
    return NextResponse.json(result.body, { headers: CORS });
  } catch (error) {
    console.error('Public landing-page order failed:', error);
    return NextResponse.json({ error: 'حدث خطأ داخلي' }, { status: 500, headers: CORS });
  }
}
