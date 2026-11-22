import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiError } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import { activeOffersForProducts } from '@/lib/offers';
import { priceIncludesDeliveryFor } from '@/lib/delivery-fees';
import { readBasePrice } from '@/lib/product-base-price';
import { quoteOrder, type QuoteOffer, type QuoteProduct } from '@/lib/order-quote';

/**
 * POST /api/orders/quote — what a hand-typed order will cost, before it is sent (order-quote.ts).
 *
 * Body: `{ items: [{ productId, offerId?, quantity }], priceIncludesDelivery? }`. Writes nothing, reserves nothing.
 * The same gate as creating the order (`orders.create`), the same store, the same live offers.
 */
const schema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().min(1).max(64),
        offerId: z.string().min(1).max(64).nullish(),
        quantity: z.number().int().min(1).max(999),
      })
    )
    .min(1, 'أضف منتجاً واحداً على الأقل')
    .max(50),
  priceIncludesDelivery: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    const { companyId, storeId, country } = await requireContext();
    await requirePermission('orders.create');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const message = zodMessage(parsed.error);
      return NextResponse.json({ error: message, errorAr: message }, { status: 400 });
    }
    const { items } = parsed.data;

    // This store's products only — the order door reads them by company; a quote never prices another store's goods.
    const productIds = [...new Set(items.map((l) => l.productId))];
    const rows = await db.product.findMany({
      where: { id: { in: productIds }, companyId, storeId },
      select: { id: true, name: true, basePrice: true },
    });
    const products = new Map<string, QuoteProduct>(
      rows.map((p) => [p.id, { id: p.id, name: p.name, basePrice: readBasePrice(p.basePrice) }])
    );

    const views = await activeOffersForProducts(db, companyId, [...products.keys()], country.minorUnit, new Date(), {
      withEvidence: false,
    });
    const offerIds = [...new Set(items.map((l) => l.offerId).filter((id): id is string => !!id))];
    // `deliveryIncluded` is not on the view; read for the chosen offers only.
    const delivery = offerIds.length
      ? new Map(
          (
            await db.offer.findMany({ where: { id: { in: offerIds }, companyId }, select: { id: true, deliveryIncluded: true } })
          ).map((o) => [o.id, o.deliveryIncluded])
        )
      : new Map<string, boolean>();
    const liveOffers = new Map<string, QuoteOffer[]>();
    for (const [productId, list] of views) {
      liveOffers.set(
        productId,
        list.map((o) => ({
          id: o.id,
          name: o.name,
          quantity: o.quantity,
          freeQuantity: o.freeQuantity,
          price: o.price,
          listPrice: o.listPrice,
          deliveryIncluded: delivery.get(o.id) ?? null,
        }))
      );
    }

    const anyChosenIncludesDelivery = offerIds.some((id) => delivery.get(id) === true);
    const priceIncludesDelivery =
      typeof parsed.data.priceIncludesDelivery === 'boolean'
        ? parsed.data.priceIncludesDelivery
        : await priceIncludesDeliveryFor(storeId, anyChosenIncludesDelivery ? true : undefined);

    const quote = quoteOrder({ lines: items, products, liveOffers, minorUnit: country.minorUnit, priceIncludesDelivery });
    return NextResponse.json({ ...quote, currency: country.currencyCode, priceIncludesDelivery });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}
