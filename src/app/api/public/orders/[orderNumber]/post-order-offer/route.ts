import { NextResponse } from 'next/server';
import { z } from 'zod';
import { rateLimit, getClientIp, UNKNOWN_IP } from '@/lib/rate-limit';
import { verifyAddonToken } from '@/lib/landing-pages';
import { ORDER_NUMBER_RE } from '@/lib/order-ref';
import { zodMessage } from '@/lib/zod-message';
import { addPostOrderOffer } from '@/lib/post-order-offer';

interface Ctx {
  params: Promise<{ orderNumber: string }>;
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

const MAX_BODY_BYTES = 2 * 1024;

/**
 * A TOKEN AND AN OFFER ID. NOTHING ELSE IS READ.
 *
 * No price, no product, no quantity, no company. Every figure is derived
 * server-side in `addPostOrderOffer`, from the seller's own offer row — so
 * there is nothing on this wire a browser could choose that would change
 * what the customer is charged.
 */
const bodySchema = z.object({
  token: z.string().min(20).max(2048),
  offerId: z.string().min(10).max(64),
});

/**
 * «آه، زيدها لطلبي» — the offer after the order.
 *
 * ── WHY ITS OWN DOOR, BESIDE THE RECOMMENDATION ONE ──
 *
 * `/api/public/landing-pages/[slug]/orders/[orderNumber]/add-product` adds a
 * product from a LANDING PAGE's recommendation list, at the product's base
 * price, and its whole security model is scoped to that page's slug. This
 * adds the PRODUCT's own post-order offer, at the offer's price, and the
 * product's offers belong to the product rather than to any one page — a
 * storefront order has no slug to be scoped by at all.
 *
 * So the path carries no slug and the ORDER is the scope, which the signed
 * token already establishes. Squeezing both into one route would have meant
 * a slug that is required for one body shape and meaningless for the other,
 * and a landing-page check that quietly excluded every storefront order from
 * a feature written for both doors.
 *
 * ── WHAT THIS FILE IS ALLOWED TO KNOW ──
 *
 * Whether the request is well-formed, and whether this visitor owns this
 * order. Everything else — the window, the gates, the offer, the price, the
 * total, the audit entry — is `post-order-offer.ts`, because a figure
 * computed in a route is a figure the next route computes differently.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { orderNumber } = await ctx.params;
    const decoded = decodeURIComponent(orderNumber);
    // The shape comes from the generator (`ORDER_NUMBER_RE`), not from a
    // literal kept here: the sibling door once demanded a hard-coded «ORD-»
    // that nothing has produced since numbering became per-store, and so
    // refused every upsell before it could be looked up. The token is what
    // proves ownership; this only keeps a malformed id out of the query.
    if (!ORDER_NUMBER_RE.test(decoded)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CORS });
    }

    /*
     * A COARSE COUNTER PER ADDRESS BEFORE THE TOKEN — and only for an address we can tell apart.
     *
     * The order's own counter used to stand here, keyed on the number in the URL, which is the one thing a stranger
     * can know: three requests with no token spent the real customer's three, and the customer was refused on
     * their own order. That counter now waits for the token (below). This one limits an address grinding at the
     * door; where the address is unknown every visitor shares one bucket, and a switch any stranger can pull is
     * worse than no limit, so it is skipped there.
     */
    const ip = getClientIp(req);
    if (ip !== UNKNOWN_IP) {
      const byIp = rateLimit(`post_order_offer_ip:${ip}`, 30, 10 * 60_000);
      if (!byIp.allowed) {
        return NextResponse.json(
          { error: `محاولات كثيرة. أعد المحاولة بعد ${byIp.retryAfterSec} ثانية` },
          { status: 429, headers: { ...CORS, 'Retry-After': String(byIp.retryAfterSec) } }
        );
      }
    }

    const contentLength = parseInt(req.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'البيانات كبيرة جدًا' }, { status: 413, headers: CORS });
    }

    // Soft origin validation — the same policy the orders endpoint and the
    // sibling add-on endpoint apply.
    const origin = req.headers.get('origin');
    if (origin && origin !== 'null') {
      try {
        const o = new URL(origin);
        if (req.headers.get('host') && o.host !== req.headers.get('host')) {
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
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400, headers: CORS });
    }
    const v = parsed.data;

    /*
     * THE SIGNED TOKEN IS THE PROOF OF OWNERSHIP, AND KNOWING AN ORDER
     * NUMBER IS NOT.
     *
     * Issued once, right after the order was created, to the screen the
     * customer is looking at. It carries the order's id and number and a
     * thirty-minute life, so an order number guessed or read off somebody
     * else's screenshot buys nothing at all.
     */
    const tok = await verifyAddonToken(v.token);
    if (!tok || tok.orderNumber !== decoded) {
      return NextResponse.json(
        { error: 'رابط الإضافة غير صالح أو منتهي الصلاحية' },
        { status: 401, headers: CORS }
      );
    }

    /*
     * ONE PRESS IS THE WHOLE FEATURE, SO THE LIMIT IS TIGHT.
     *
     * The offer may be taken once per order and `postOrderGate` enforces
     * that from the row — this is about the cost of being told so. Three
     * attempts in the window covers a double-press and a flaky connection;
     * a script probing offer ids against one order gets a 429 instead of a
     * free oracle. Keyed on the order the TOKEN proves, so only its owner
     * can spend it.
     */
    const rl = rateLimit(`post_order_offer:${tok.orderId}`, 3, 30 * 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `محاولات كثيرة. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` },
        { status: 429, headers: { ...CORS, 'Retry-After': String(rl.retryAfterSec) } }
      );
    }

    const result = await addPostOrderOffer({
      orderId: tok.orderId,
      orderNumber: tok.orderNumber,
      offerId: v.offerId,
    });

    if (!result.ok) {
      /*
       * A REFUSAL THE SCREEN CAN ACT ON, AND A STATUS THAT MEANS SOMETHING.
       *
       * 409 for «the order has moved on» — the request was legitimate and
       * the state answered no, which is what a conflict is, and the screen
       * shows the sentence and hides the offer. 404 for an offer that is not
       * there or not on this order, which is also what a prober is told, so
       * the two are indistinguishable from outside.
       *
       * `reason` travels beside the sentence because the SCREEN has one
       * decision to make — keep showing the offer or stop — and parsing
       * Arabic prose to make it is how a message becomes an API.
       */
      const gone = result.reason === 'OFFER_GONE' || result.reason === 'NOT_IN_ORDER';
      return NextResponse.json(
        { error: result.message, reason: result.reason },
        { status: gone ? 404 : 409, headers: CORS }
      );
    }

    return NextResponse.json(
      {
        success: true,
        orderNumber: result.orderNumber,
        addOn: result.addOn,
        // Server-authoritative, and the ONLY number the screen may print
        // as the new total. The same rule covers the words: a refusal's
        // Arabic sentence comes from `POST_ORDER_REFUSAL_AR` on the
        // server, not from a map of codes kept in the page.
        newTotal: result.newTotal,
        currency: result.currency,
      },
      { headers: CORS }
    );
  } catch (error) {
    console.error('Post-order offer add failed:', error);
    return NextResponse.json({ error: 'حدث خطأ داخلي' }, { status: 500, headers: CORS });
  }
}
