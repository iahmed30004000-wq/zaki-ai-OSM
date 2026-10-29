import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderReadable } from '@/lib/rbac';
import { apiErrorResponse } from '@/lib/api-error';
import { can } from '@/lib/authorization';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';
import { deriveCoreState } from '@/lib/order-state';
import { reviewPath } from '@/lib/review-link';

/**
 * THE LINK THE OWNER COPIES AND SENDS OVER WHATSAPP.
 *
 * Owner decision D8 asks for the rating to be reachable two ways: offered
 * to the customer on the tracking page, and handed to the seller to send.
 * This is the second one.
 *
 * ── WHY IT IS A DOOR AND NOT A COLUMN ON THE ORDER PAYLOAD ──
 *
 * The order detail response is read by every role that may open an order,
 * and the link is a credential: whoever holds it may post one opinion in
 * this shop's name about this product. So it is asked for deliberately,
 * once, by somebody who went looking for it — and the asking is a request
 * in the log rather than a field in every response.
 *
 * ── AND IT IS REFUSED BEFORE DELIVERY ──
 *
 * `deriveCoreState` and not a comparison written out here: the system has
 * one reading of «where is this order» and a second one would disagree with
 * it the first time a status was added. A link handed out before the goods
 * arrived is an invitation to rate a parcel nobody has opened.
 *
 * A PATH, never an absolute URL. The shop may have its own domain, and a
 * link built from an env var is a link that is wrong the day somebody moves
 * the deployment. The screen prefixes the store's own address.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();

    // The same envelope the list applies — see `a-queue-row-opens.test.ts`:
    // a row somebody may see in their queue is a row they may open.
    // The review link has a key of its own (PR-6): `orders.rating_link`, given to everybody who held `orders.view`.
    if (!can(user, 'orders.rating_link')) {
      return NextResponse.json(
        { error: 'ما عندك صلاحية نسخ رابط التقييم.', errorAr: 'ما عندك صلاحية نسخ رابط التقييم.', code: 'RATING_LINK_FORBIDDEN' },
        { status: 403 }
      );
    }
    const access = await assertOrderReadable(id, user, { companyId, storeId }, 'orders.view');
    if (!access.allowed) {
      /*
       * ARABIC IN `error` ITSELF, AND NOT THE GROUP'S USUAL PAIR.
       *
       * Every other route here sends an English `error` with `errorAr`
       * beside it, and `order-refusals.ts` explains why: fifteen test
       * files assert on those English strings and support reads the
       * permission key out of them. NOTHING asserts on a door written
       * today — so the English half would be a new entry on a ratchet
       * (`arabic-refusals.test.ts`) that may only fall, bought for
       * nobody's benefit. `errorAr` travels too, because ten components
       * read that field first.
       */
      return NextResponse.json(
        { error: ORDER_NOT_FOUND, errorAr: ORDER_NOT_FOUND },
        { status: ORDER_ACCESS_STATUS[access.reason] }
      );
    }

    const order = await db.order.findFirst({
      where: { id, companyId },
      select: {
        id: true,
        shippingStatus: true,
        confirmationStatus: true,
        claimedById: true,
        store: { select: { slug: true } },
        reviews: { select: { id: true, status: true }, take: 1 },
      },
    });
    if (!order) {
      return NextResponse.json({ error: ORDER_NOT_FOUND, errorAr: ORDER_NOT_FOUND }, { status: 404 });
    }

    const state = deriveCoreState(order);
    if (state !== 'DELIVERED' && state !== 'PARTIALLY_DELIVERED') {
      return NextResponse.json(
        { error: 'رابط التقييم بيفتح بعد تسليم الطلب.' },
        { status: 400 }
      );
    }
    if (!order.store?.slug) {
      return NextResponse.json({ error: 'الطلب ما مربوط بمتجر له عنوان عام.' }, { status: 400 });
    }

    /*
     * ALREADY RATED IS SAID, AND THE LINK IS STILL RETURNED.
     *
     * Not withheld: the link is derived, so it is the same string whether
     * or not it has been used, and pretending otherwise would be theatre.
     * What matters is that the seller is told before he sends it, instead
     * of the customer finding out — and the door the link opens refuses
     * the second submission anyway, because `product_reviews_order_key`
     * does.
     */
    return NextResponse.json({
      path: reviewPath(order.store.slug, order.id),
      alreadyRated: order.reviews.length > 0,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
