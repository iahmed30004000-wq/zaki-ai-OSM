import { deviceClassOf } from '@/lib/landing-views';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { getStorefront } from '@/lib/storefront';
import { createPublicOrder, type SellingSurface } from '@/lib/public-order';
import { resolveCampaign } from '@/lib/campaigns-server';
import { MAX_CART_LINES } from '@/lib/cart';
import { checkoutRules } from '@/lib/store-theme';

/**
 * A BASKET, FROM A SHOP THAT SELLS MORE THAN ONE THING.
 *
 * The same shop, the same rules and the same `createPublicOrder` as the
 * product page beside it — validation against the country, the blacklist,
 * the duplicate guard, the customer record, the one COD function, the Order
 * row. This route decides only WHICH shop a stranger is standing in and
 * WHICH of its products the basket named. A second copy of the order rules
 * would drift on the day one of them changed, and those rules decide what a
 * customer is charged.
 *
 * WHAT THIS ROUTE OWNS: the scoping. Product ids arrive from a browser, so
 * they are looked up inside THIS store — an id belonging to another shop's
 * catalogue simply is not found, and the order path then refuses it by name
 * rather than pricing it against the wrong stock.
 */

interface Ctx {
  params: Promise<{ store: string }>;
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

/** Bigger than the single-product door's: a basket carries up to twenty lines. */
const MAX_BODY_BYTES = 24 * 1024;

/** The product ids a basket named, bounded and deduplicated, or none. */
function basketProductIds(raw: unknown): string[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const row of items.slice(0, MAX_CART_LINES)) {
    const id = (row as { productId?: unknown } | null)?.productId;
    if (typeof id === 'string' && id.length > 0 && id.length <= 64 && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { store: slug } = await ctx.params;
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) {
      return NextResponse.json({ error: 'هذا المتجر غير موجود' }, { status: 404, headers: CORS });
    }

    const ip = getClientIp(req);
    const rl = rateLimit(`store_cart_order:${ip}`, 10, 10 * 60_000);
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

    // A storefront is a real page on a real host, so a cross-site origin
    // naming a different host is refused outright.
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

    // A disabled storefront reads as absent: a shop that is not open must
    // not take money.
    const store = await getStorefront(slug);
    if (!store) return NextResponse.json({ error: 'هذا المتجر غير موجود' }, { status: 404, headers: CORS });

    const wanted = basketProductIds(raw);
    if (wanted.length === 0) {
      return NextResponse.json(
        { error: 'السلة فارغة. أضف منتجاً قبل إتمام الطلب.' },
        { status: 400, headers: CORS }
      );
    }

    // THIS store's products. Scoped by company AND store, because a shop
    // that could be handed another shop's product id would book the order
    // against its own stock.
    const products = await db.product.findMany({
      where: {
        id: { in: wanted },
        companyId: store.companyId,
        storeId: store.id,
        status: 'ACTIVE',
        basePrice: { gt: 0 },
      },
      select: { id: true, name: true, image: true, basePrice: true },
    });
    if (products.length === 0) {
      return NextResponse.json(
        { error: 'لم يعد أيٌّ من منتجات السلة متاحاً. أعد تحميل الصفحة.' },
        { status: 400, headers: CORS }
      );
    }

    const country = await db.country.findUnique({
      where: { id: store.countryId },
      select: { code: true, currencyCode: true, orderPrefix: true, minorUnit: true },
    });
    if (!country) {
      return NextResponse.json({ error: 'هذا المتجر لا يقبل الطلبات حاليًا' }, { status: 409, headers: CORS });
    }

    // A code, checked against this store's campaigns — never an id from the
    // browser.
    const campaignId = await resolveCampaign(store.companyId, store.id, (raw as { campaign?: unknown } | null)?.campaign);

    const surface: SellingSurface = {
      deviceClass: deviceClassOf(req.headers.get('user-agent')),
      companyId: store.companyId,
      store: { id: store.id, countryId: store.countryId, country },
      products,
      landingPage: null,
      campaignId,
      // What the store's «الدفع» requires — from the LIVE theme `getStorefront` read, the one the checkout was drawn from.
      checkout: checkoutRules(store.theme),
      source: 'Store',
      /**
       * PER STORE, not per product.
       *
       * The single-product door scopes by product, because buying a second
       * thing from the same shop minutes later is not a duplicate. A basket
       * is different: it already IS everything the customer wanted, so a
       * second submission from the same phone within the window is the
       * «اطلب» button pressed twice — which is the whole reason the guard
       * exists. Scoping by the basket's contents instead would hand a bot a
       * way around it for the price of adding one item.
       */
      dedupeScope: `store-cart:${store.id}`,
      notice: {
        title: 'طلب جديد من المتجر',
        message: (n) => `طلب جديد #${n} من متجر "${store.name}" — ${products.length} صنف.`,
      },
    };

    const result = await createPublicOrder(surface, raw);
    if (!result.ok) {
      return NextResponse.json(result.body, { status: result.status, headers: { ...CORS, ...(result.headers ?? {}) } });
    }
    return NextResponse.json(result.body, { headers: CORS });
  } catch (e) {
    console.error('POST /api/public/stores/[store]/orders', e);
    return NextResponse.json({ error: 'تعذر إرسال الطلب' }, { status: 500, headers: CORS });
  }
}
