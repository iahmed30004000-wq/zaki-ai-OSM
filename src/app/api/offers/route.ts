import { NextResponse } from 'next/server';
import { refreshLandingPages } from '@/lib/landing-cache';
import { z } from 'zod';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { inStore } from '@/lib/store-filter';
import { requireContext } from '@/lib/geo-context';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authorization';
import { offerInputSchema, clearOtherDefaults, clearOtherPostOrderOffers, offerAboveBaseRefusal } from '@/lib/offers';
import { offerAboveBase, offerCeiling } from '@/lib/offer-ceiling';
import { zodMessage } from '@/lib/zod-message';

/**
 * A product's offers — the ONE place a bundle and its price are defined.
 *
 * They used to live in two places: here, and again on each landing page. A
 * price raised in the catalogue never reached the page selling it, and the
 * two disagreed silently. Now the product owns its offers and every surface
 * — landing page, quick order, the order screen — reads them from here.
 */

export async function GET(req: Request) {
  try {
    const { companyId, storeId, country } = await requireContext();
    await requirePermission('offers.view');

    const productId = new URL(req.url).searchParams.get('productId')?.trim() || undefined;

    const offers = await db.offer.findMany({
      // An offer has no store of its own — it hangs off a product, and the
      // product has one. Scoping through the relation rather than adding a
      // column: a copy of the store id on the offer is a second place for
      // it to be wrong, and they would disagree the first time a product
      // moved.
      where: { companyId, product: { storeId: storeId ?? '' }, ...(productId ? { productId } : {}) },
      include: {
        product: {
          select: { id: true, name: true, sku: true, basePrice: true, image: true },
        },
      },
      // The order the customer will see them in, not the order they were typed.
      orderBy: productId
        ? [{ sortOrder: 'asc' }, { quantity: 'asc' }]
        : [{ createdAt: 'desc' }],
    });

    /*
     * EACH ROW CARRIES ITS OWN LINE — «العرض ما بصير يكون اكثر من السعر الاساسي».
     *
     * `maxPrice` is the most the bundle may cost (its paid pieces × its product's base price, rounded by this
     * store's currency) and `aboveBase` says whether it costs more. Both are worked out HERE, by the function the
     * two write doors refuse with, so the screen prints the server's figure and does no arithmetic of its own on a
     * stored row. An offer saved before the rule existed stays on sale exactly as it is; these two fields are how
     * the screen flags it. `minorUnit` is the store's own, so the hint the screen draws for a box being typed is
     * rounded the way this door will round it.
     */
    return NextResponse.json({
      offers: offers.map((o) => ({
        ...o,
        maxPrice: offerCeiling(o.product.basePrice, o.quantity, country.minorUnit),
        aboveBase: offerAboveBase(o, o.product.basePrice, country.minorUnit) !== null,
      })),
      minorUnit: country.minorUnit,
    });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('offers.manage');

    const parsed = offerInputSchema.extend({ productId: z.string().min(10).max(64) })
      .safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: zodMessage(parsed.error) },
        { status: 400 }
      );
    }
    const input = parsed.data;

    // Tenant-validate the referenced product before writing anything.
    // Not found rather than refused: a product of another store is simply
    // not one this caller can name.
    const product = await db.product.findFirst({ where: { id: input.productId, ...inStore(companyId, storeId) } });
    if (!product) {
      return NextResponse.json({ error: 'المنتج غير موجود في شركتك' }, { status: 404 });
    }

    // «العرض ما بصير يكون اكثر من السعر الاساسي». Measured against the product just read — a product of another
    // store has already answered 404 above, so its base price is never quoted to this caller — and before the
    // transaction, so a refused bundle leaves no row, no audit entry and no rebuilt page behind it.
    const aboveBase = offerAboveBaseRefusal(input, product.basePrice, country.minorUnit);
    if (aboveBase) return NextResponse.json(aboveBase, { status: 400 });

    const offer = await db.$transaction(async (tx) => {
      const created = await tx.offer.create({
        data: {
          companyId,
          productId: input.productId,
          name: input.name.trim(),
          quantity: input.quantity,
          freeQuantity: input.freeQuantity,
          sellingPrice: input.sellingPrice,
          compareAtPrice: input.compareAtPrice ?? null,
          endsAt: input.endsAt ?? null,
          discount: input.discount,
          deliveryIncluded: input.deliveryIncluded,
          postOrderOffer: input.postOrderOffer,
          isDefault: input.isDefault,
          sortOrder: input.sortOrder,
          status: input.status,
        },
      });
      // Exactly one default per product — see clearOtherDefaults.
      await clearOtherDefaults(tx, created);
      // And exactly one offer after the order — the same rule, the same way.
      await clearOtherPostOrderOffers(tx, created);
      return created;
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'OFFER_CREATED',
      entity: 'Offer',
      entityId: offer.id,
      newData: offer,
    });

    await refreshLandingPages({ productId: offer.productId, companyId });
    return NextResponse.json({ success: true, offer });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}
