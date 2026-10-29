import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { rateLimit, getClientIp, UNKNOWN_IP } from '@/lib/rate-limit';
import { verifyAddonToken } from '@/lib/landing-pages';
import { ORDER_NUMBER_RE } from '@/lib/order-ref';
import { zodMessage } from '@/lib/zod-message';
import { roundMinor } from '@/lib/money';
import { POST_ORDER_REFUSAL_AR, postOrderGate, postOrderOfferSettings } from '@/lib/post-order-offer';

interface Ctx {
  params: Promise<{ slug: string; orderNumber: string }>;
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

// Client sends ONLY the signed token + the recommendationId (from the
// server-provided success-screen list). No price / product / quantity /
// company — everything is derived server-side.
const addonSchema = z.object({
  token: z.string().min(20).max(2048),
  recommendationId: z.string().min(10).max(64),
});

/**
 * Public add-product-to-existing-order endpoint (upsells).
 *
 * Security model:
 *  - the short-lived signed addon token (30m, issued right after order
 *    creation) proves this anonymous visitor owns THIS order — knowing the
 *    orderNumber alone is NOT enough to modify someone else's order.
 *  - the recommendation must belong to the SAME landing page.
 *  - price/total are taken from the DB product — client values ignored.
 *  - no status changes, no customer changes, no cross-order access.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { slug, orderNumber } = await ctx.params;
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CORS });
    }
    // The shape comes from the generator, not from a copy kept here: this
    // check used to demand a literal "ORD-" that nothing has produced since
    // numbering became per-store, and so refused every upsell before it
    // could be looked up. The token is what proves ownership; this only
    // keeps a malformed id out of the query.
    if (!ORDER_NUMBER_RE.test(decodeURIComponent(orderNumber))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CORS });
    }

    /*
     * A COARSE COUNTER PER ADDRESS BEFORE THE TOKEN — and only for an address we can tell apart.
     *
     * The per-order counter used to stand here, keyed on the order number in the URL, which is the one thing a
     * stranger can know: five requests with no token at all spent the real customer's five, and the customer was
     * told «محاولات كثيرة» about their own order. The order's counter now waits for the token (below); this one
     * limits a single address grinding at the door. Where the address is unknown (`UNKNOWN_IP`) every visitor
     * shares one bucket, and a switch any stranger can pull is worse than no limit — so it is skipped there.
     */
    const ip = getClientIp(req);
    if (ip !== UNKNOWN_IP) {
      const byIp = rateLimit(`lp_addon_ip:${ip}`, 30, 10 * 60_000);
      if (!byIp.allowed) {
        return NextResponse.json(
          { error: `محاولات كثيرة جدًا. أعد المحاولة بعد ${byIp.retryAfterSec} ثانية` },
          { status: 429, headers: { ...CORS, 'Retry-After': String(byIp.retryAfterSec) } }
        );
      }
    }

    const contentLength = parseInt(req.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'البيانات كبيرة جدًا' }, { status: 413, headers: CORS });
    }

    // Soft origin validation (same policy as the orders endpoint)
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
    const parsed = addonSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: zodMessage(parsed.error) },
        { status: 400, headers: CORS }
      );
    }
    const v = parsed.data;

    // ─── Signed token: proves ownership of this order, 30-minute TTL ───
    const tok = await verifyAddonToken(v.token);
    if (!tok || tok.orderNumber !== decodeURIComponent(orderNumber)) {
      return NextResponse.json({ error: 'رابط الإضافة غير صالح أو منتهي الصلاحية' }, { status: 401, headers: CORS });
    }

    // Rate limit add-ons — counted on the order the TOKEN proves, so only its owner spends it.
    const rl = rateLimit(`lp_addon:${tok.orderId}`, 5, 30 * 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `محاولات كثيرة جدًا. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` },
        { status: 429, headers: { ...CORS, 'Retry-After': String(rl.retryAfterSec) } }
      );
    }

    // ─── Resolve order: token orderId + orderNumber + landing-page slug must all match ───
    const order = await db.order.findFirst({
      where: { id: tok.orderId, orderNumber: tok.orderNumber },
      include: {
        // Whether anybody has called about this order yet — one of the gates below.
        _count: { select: { contactAttempts: true } },
        landingPage: { select: { id: true, name: true, slug: true, isPublished: true } },
        // The CURRENCY'S minor unit, which decides where this money rounds.
        // See below — it is not two decimals everywhere.
        store: { select: { country: { select: { minorUnit: true } } } },
      },
    });
    if (!order || !order.landingPage || order.landingPage.slug !== slug) {
      return NextResponse.json({ error: 'غير مسموح' }, { status: 404, headers: CORS });
    }
    // Unpublished page → upsells disappear for everyone (fail-closed)
    if (!order.landingPage.isPublished) {
      return NextResponse.json({ error: 'غير مسموح' }, { status: 403, headers: CORS });
    }

    /*
     * THE LINK CLOSES WHEN THE ORDER IS CONFIRMED — «مجرد ما يتأكد الطلب، ممنوع الأب سيل والكروس سيل، والرابط اللي
     * معه تنتهي صلاحيته».
     *
     * The offer after the order already closed then (`postOrderGate`); a recommended product did not: its token lives
     * thirty minutes, and an agent could confirm the order — and the warehouse reserve it — while the customer kept
     * adding goods nobody would see. The same gate, the same sentences: still NEW on both stages, nobody has called
     * yet, inside the seller's window. Only «once» is not asked: a customer may take more than one recommendation.
     */
    const { windowMinutes } = await postOrderOfferSettings(order.companyId);
    const { status, confirmationStatus, createdAt } = order;
    const gate = postOrderGate(
      {
        status,
        confirmationStatus,
        createdAt,
        contactAttempts: order._count.contactAttempts,
        postOrderAddOns: 0,
      },
      windowMinutes,
      new Date()
    );
    if (!gate.allowed) {
      return NextResponse.json({ error: POST_ORDER_REFUSAL_AR[gate.reason], code: gate.reason }, { status: 409, headers: CORS });
    }

    // ─── Recommendation must belong to THIS landing page and be active ───
    const rec = await db.landingPageRecommendation.findFirst({
      where: { id: v.recommendationId, landingPageId: order.landingPage.id, isActive: true },
      include: { product: { select: { id: true, name: true, basePrice: true, image: true, status: true } } },
    });
    if (!rec) {
      return NextResponse.json(
        { error: 'المنتج المقترح غير متاح' },
        { status: 400, headers: CORS }
      );
    }
    if (!rec.product || rec.product.status !== 'ACTIVE') {
      return NextResponse.json({ error: 'المنتج غير متاح حاليًا' }, { status: 409, headers: CORS });
    }

    const unitPrice = rec.product.basePrice; // server-side price — never from the browser
    // A product at nothing is not a suggestion: it would be added at 0 and shipped free.
    if (!(unitPrice > 0)) {
      return NextResponse.json({ error: 'المنتج غير متاح حاليًا' }, { status: 409, headers: CORS });
    }
    const addQty = 1; // one unit per add — client cannot choose quantity

    /*
     * TWO DECIMALS IS NOT A ROUNDING RULE, IT IS A GUESS ABOUT THE CURRENCY.
     *
     * This was `Number((unitPrice * addQty).toFixed(2))`, and the figure it
     * produces is WRITTEN — to the add-on row, to the order's `totalAmount`
     * (which is what the courier is told to collect) and to the page's
     * `upsellRevenue`. On the Jordanian store in this database the currency
     * is JOD with **minorUnit 3**, so an add-on at 1.234 was stored as 1.23:
     * a fils lost on the order, and three rows disagreeing with the product
     * they came from.
     *
     * `roundMinor` is the rule the rest of the money uses — `computeCod`,
     * `allocateDiscount`, the delivery fee and the waybill all round through
     * it. A second rounding rule in the one place that writes money after an
     * order exists is exactly the «same figure computed twice» the audit
     * hunts, and the two disagree whenever the currency is not 1/100.
     */
    const minorUnit = order.store?.country?.minorUnit ?? 2;
    const addTotal = roundMinor(unitPrice * addQty, minorUnit);

    // ─── Update the SAME order server-side (no new order, total from DB) ───
    const result = await db.$transaction(async (tx) => {
      /*
       * THE ORDER'S ROW IS LOCKED FIRST — two presses at the same moment add once.
       *
       * Both read the order before this point, both passed the gate, and both wrote: the total grew by the
       * recommendation twice. An UPDATE holds the row until the transaction ends, so the second press waits here,
       * then re-reads the order AS IT IS NOW (it may have been confirmed or called meanwhile) and the add-ons it
       * already has. The `version` moves with it, so a staff member saving from a copy older than this add-on is
       * told the order changed instead of overwriting it.
       */
      await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } }, select: { id: true } });
      const now = await tx.order.findFirst({
        where: { id: order.id },
        select: { status: true, confirmationStatus: true, createdAt: true, totalAmount: true, _count: { select: { contactAttempts: true } } },
      });
      const regate = postOrderGate(
        {
          status: now?.status ?? status,
          confirmationStatus: now?.confirmationStatus ?? confirmationStatus,
          createdAt: now?.createdAt ?? createdAt,
          contactAttempts: now?._count.contactAttempts ?? 0,
          postOrderAddOns: 0,
        },
        windowMinutes,
        new Date()
      );
      if (!regate.allowed) return { kind: 'refused' as const, reason: regate.reason };
      // The same suggestion twice is ONE add-on: the repeat is answered with what is already on the order.
      const existing = await tx.orderAddOn.findFirst({
        where: { orderId: order.id, productId: rec.product.id, landingPageId: order.landingPage!.id, offerId: null },
      });
      if (existing) return { kind: 'existing' as const, existing, total: Number(now?.totalAmount ?? order.totalAmount) };

      const addOn = await tx.orderAddOn.create({
        data: {
          companyId: order.companyId,
          orderId: order.id,
          productId: rec.product.id,
          landingPageId: order.landingPage!.id,
          productName: rec.product.name,
          quantity: addQty,
          price: unitPrice,
          total: addTotal,
        },
      });
      const updated = await tx.order.update({
        where: { id: order.id },
        data: { totalAmount: { increment: addTotal } },
      });
      await tx.landingPage.update({
        where: { id: order.landingPage!.id },
        data: {
          upsellAddsCount: { increment: 1 },
          upsellRevenue: { increment: addTotal },
        },
      });
      await tx.orderActivity.create({
        data: {
          companyId: order.companyId,
          orderId: order.id,
          userId: null,
          action: 'UPSELL_ADDED',
          newStatus: null,
          metadata: JSON.stringify({
            source: 'Landing Page',
            addOnId: addOn.id,
            product: rec.product.name,
            quantity: addQty,
            price: unitPrice,
            landingPage: order.landingPage!.name,
          }),
        },
      });
      return { kind: 'added' as const, addOn, order: updated };
    });

    if (result.kind === 'refused') {
      return NextResponse.json({ error: POST_ORDER_REFUSAL_AR[result.reason], code: result.reason }, { status: 409, headers: CORS });
    }
    if (result.kind === 'existing') {
      return NextResponse.json(
        {
          success: true,
          alreadyAdded: true,
          orderNumber: order.orderNumber,
          addOn: {
            id: result.existing.id,
            productName: result.existing.productName,
            price: result.existing.price,
            quantity: result.existing.quantity,
          },
          newTotal: result.total,
        },
        { headers: CORS }
      );
    }

    return NextResponse.json(
      {
        success: true,
        orderNumber: result.order.orderNumber,
        addOn: { id: result.addOn.id, productName: result.addOn.productName, price: result.addOn.price, quantity: result.addOn.quantity },
        newTotal: result.order.totalAmount,
      },
      { headers: CORS }
    );
  } catch (error) {
    console.error('Public add-product failed:', error);
    return NextResponse.json({ error: 'حدث خطأ داخلي' }, { status: 500, headers: CORS });
  }
}