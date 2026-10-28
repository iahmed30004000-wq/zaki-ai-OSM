import { deviceClassOf } from '@/lib/landing-views';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { getStorefront } from '@/lib/storefront';
import { createPublicOrder, type SellingSurface } from '@/lib/public-order';
import { resolveCampaign } from '@/lib/campaigns-server';
import { checkoutRules } from '@/lib/store-theme';

/**
 * Public order intake from a storefront.
 *
 * The same shop as the landing page, through a different door. This route
 * only decides WHICH product in WHICH store a stranger is standing in front
 * of; everything after — validation against the country, the blacklist, the
 * duplicate guard, the customer record, the one cod function, the Order row
 * — is createPublicOrder, shared with the landing page. A second copy of
 * those rules would drift on the day one of them changed, and the rules here
 * decide what a customer is charged.
 */

interface Ctx {
  params: Promise<{ store: string; sku: string }>;
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

const MAX_BODY_BYTES = 10 * 1024;

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { store: slug, sku } = await ctx.params;
    if (!/^[a-z0-9-]{2,60}$/.test(slug) || !/^[A-Za-z0-9._-]{1,64}$/.test(sku)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CORS });
    }

    const ip = getClientIp(req);
    const rl = rateLimit(`store_order:${ip}`, 10, 10 * 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `محاولات كثيرة جدًا. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` },
        { status: 429, headers: { ...CORS, 'Retry-After': String(rl.retryAfterSec) } }
      );
    }

    const contentLength = parseInt(req.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'البيانات كبيرة جدًا' }, { status: 413, headers: CORS });
    }

    // Origin validation: a storefront is a real page on a real host, so a
    // cross-site origin naming a different host is refused outright.
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

    // ─── Resolve the store → product (server-side only) ───
    // A disabled storefront reads as absent: a shop that is not open must
    // not take money.
    const store = await getStorefront(slug);
    if (!store) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CORS });

    // THIS store's product. Read by company, a shop sold another shop's
    // product and booked the order against its own stock.
    const product = await db.product.findFirst({
      where: { companyId: store.companyId, storeId: store.id, sku: sku.toUpperCase(), status: 'ACTIVE', basePrice: { gt: 0 } },
      select: { id: true, name: true, image: true, basePrice: true },
    });
    if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CORS });

    // No door is shut by the store's type here. A Single Product store with
    // a front page sends new visitors to it, but a customer who opened the
    // product page a minute before the page was picked is mid-order — and
    // refusing them would lose a sale to an error they cannot read.

    const country = await db.country.findUnique({
      where: { id: store.countryId },
      select: { code: true, currencyCode: true, orderPrefix: true, minorUnit: true },
    });
    if (!country) {
      return NextResponse.json({ error: 'هذا المتجر لا يقبل الطلبات حاليًا' }, { status: 409, headers: CORS });
    }

    // The same resolution as the landing page: a code, checked against this
    // store's campaigns, never an id from the browser.
    const campaignId = await resolveCampaign(
      store.companyId,
      store.id,
      (raw as { campaign?: unknown } | null)?.campaign
    );

    const surface: SellingSurface = {
      deviceClass: deviceClassOf(req.headers.get('user-agent')),
      companyId: store.companyId,
      store: { id: store.id, countryId: store.countryId, country },
      products: [product],
      landingPage: null,
      campaignId,
      // What the store's «الدفع» requires — from the LIVE theme `getStorefront` read, the one the form was drawn from.
      checkout: checkoutRules(store.theme),
      source: 'Store',
      // Per product, not per store: a customer buying a second thing from
      // the same shop minutes later is not a duplicate submission.
      dedupeScope: `store:${store.id}:${product.id}`,
      notice: {
        title: 'طلب جديد من المتجر',
        message: (n) => `طلب جديد #${n} من متجر "${store.name}" — ${product.name}.`,
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
    console.error('Public storefront order failed:', error);
    return NextResponse.json({ error: 'حدث خطأ داخلي' }, { status: 500, headers: CORS });
  }
}
