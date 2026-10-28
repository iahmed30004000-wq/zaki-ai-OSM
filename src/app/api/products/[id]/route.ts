import { sellingCurrency } from '@/lib/selling-currency';
import { refreshLandingPages } from '@/lib/landing-cache';
import { NextResponse } from 'next/server';
import { apiErrorResponse, forbiddenAr } from '@/lib/api-error';
import { db } from '@/lib/db';
import { inStore } from '@/lib/store-filter';
import { deleteStoredFile } from '@/lib/storage';
import { logAudit } from '@/lib/audit';
import { parseCategoryAttributes, parseProductAttributes } from '@/lib/product-attributes';
import { productCosts } from '@/lib/product-cost';
import { maySeeCost, withoutCost } from '@/lib/cost-visibility';
import { parseHistory, rememberSlug, slugify, uniqueSlug } from '@/lib/slug';
import { can, authorize } from '@/lib/authorization';
import { requireContext } from '@/lib/geo-context';
import { BASE_PRICE_NOT_A_NUMBER, readBasePrice } from '@/lib/product-base-price';
import { baseBelowActiveOffersRefusal } from '@/lib/offers';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    // This store's product, as editing it already asks (inStore below in
    // PATCH) — an id of another store of the company used to open it here.
    const product = await db.product.findFirst({
      where: { id, ...inStore(companyId, storeId) },
      include: {
        images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
        // The category's QUESTIONS travel with the product's answers.
        // Apart, the card that edits them would have to ask twice and
        // could draw an answer against a schema that had since changed.
        category: { select: { id: true, name: true, attributeSchema: true } },
        /*
         * ── THE SCREEN HAS ALWAYS READ THESE. THE DOOR NEVER SENT THEM ──
         *
         * `ProductDetailScreen` reads `data.analytics`, `product.batches`
         * and `product.orders`. This route returned `{ product,
         * currencyCode }` and the product's own columns — since the first
         * commit. So four cards on that page were blank for ever:
         * «أداء المبيعات», «المخزون», «تشغيلات الإنتاج» and «أحدث
         * الطلبات».
         *
         * It reads as «we have no data», which about a product that has
         * sold for months is a lie the screen tells with a straight face.
         * The owner reported the symptom twice — «المخزون اللي فوق» and
         * «تشغيلات الإنتاج» — without either of us knowing they were the
         * same missing key.
         */
        batches: {
          orderBy: { productionDate: 'desc' },
          take: 20,
          select: {
            id: true, batchNumber: true, quantityProduced: true, quantitySold: true,
            quantityRemaining: true, productionDate: true, createdAt: true,
            status: true, notes: true, openingCountId: true,
            manufacturingCost: true, packagingCost: true, rawMaterialCost: true,
            otherCosts: true, totalProductionCost: true, costPerUnit: true,
          },
        },
      },
    });
    // Scope-evaluated view authorization — out-of-scope products report 404
    const viewAuth = product ? authorize(user, 'products.view', product) : { allowed: false, reason: 'NO_PERMISSION' as const };
    if (!product || viewAuth.reason === 'NO_TENANT' || viewAuth.reason === 'OUT_OF_SCOPE') {
      return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });
    }
    if (!viewAuth.allowed) {
      return NextResponse.json({ error: 'Forbidden: missing required permission products.view', errorAr: forbiddenAr('Forbidden: missing required permission products.view') }, { status: 403 });
    }
    // The currency of the COUNTRY this store sells into — not the company's.
    // A Syrian store was labelling its prices in Jordanian dinars because the
    // company that owns it is Jordanian, and the landing page selling the
    // same product said something else.
    let currencyCode = 'USD';
    try {
      const { country } = await requireContext();
      currencyCode = country.currencyCode;
    } catch {
      // No store selected: the company's first country, never the retired
      // company-level currency.
      currencyCode = await sellingCurrency(null, companyId);
    }

    /*
     * ── THE SAME ARITHMETIC THE LIST ALREADY DOES ──
     *
     * `productCosts`, `maySeeCost` and `withoutCost` are the list route's
     * (`products/route.ts:109-169`). Reusing them is the point: two
     * places computing «how many were produced» is two answers to one
     * question, and the one on this page would be the one nobody
     * cross-checks.
     *
     * ⚠️ Cost is withheld from whoever may not see it, and the batches
     * have their money STRIPPED rather than zeroed — a zero is a claim,
     * and «this cost nothing» is a false one.
     */
    const showCost = maySeeCost(user);
    const totalProduced = product.batches.reduce((s, b) => s + b.quantityProduced, 0);
    const totalSold = product.batches.reduce((s, b) => s + b.quantitySold, 0);
    const totalRemaining = product.batches.reduce((s, b) => s + b.quantityRemaining, 0);
    const costOf = showCost ? await productCosts(db, companyId, [product.id]) : new Map();

    return NextResponse.json({
      product: {
        ...product,
        batches: showCost ? product.batches : product.batches.map(withoutCost),
      },
      analytics: {
        totalProduced,
        totalSold,
        totalRemaining,
        ...(showCost
          ? { avgCostPerUnit: Number((costOf.get(product.id)?.average ?? 0).toFixed(2)) }
          : {}),
      },
      currencyCode,
    });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}

/** PATCH — edit product info (name, nameEn, description, basePrice, status, SKU) */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();

    const body = await req.json();
    const { name, nameEn, sku, description, descriptionEn, basePrice, status, sourceType, categoryId, attributes } = body;

    const existing = await db.product.findFirst({
      where: { id, ...inStore(companyId, storeId) },
      // The category comes with it because the answers below are read
      // against ITS questions; a second query for one column would be a
      // round trip on every product edit.
      include: { category: { select: { attributeSchema: true } } },
    });
    if (!existing || existing.companyId !== companyId) {
      return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });
    }

    // Scope-evaluated edit authorization (out-of-scope → 404)
    const editAuth = authorize(user, 'products.edit', existing);
    if (!editAuth.allowed) {
      if (editAuth.reason === 'NO_TENANT' || editAuth.reason === 'OUT_OF_SCOPE') {
        return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });
      }
      return NextResponse.json({ error: 'Forbidden: missing required permission products.edit', errorAr: forbiddenAr('Forbidden: missing required permission products.edit') }, { status: 403 });
    }

    /**
     * WHAT WAS TYPED IN THE PRICE BOX, OR A 400.
     *
     * This door used to write `parseFloat(basePrice) || 0`, so editing a
     * product and leaving anything non-numeric in the price box turned it
     * into a **free product** and answered 200 — the audit log even recorded
     * the old price next to the new zero, and nobody reads an audit log to
     * find out that a price was lost.
     *
     * Read once, here, by the same reader the create door uses
     * (`product-base-price.ts`), and used for BOTH the price-authority check
     * below and the write. `Number(basePrice)` was computed separately for
     * that check, so a garbage price was `NaN !== existing` — it demanded
     * the price permission and then wrote a zero.
     *
     * Absent still leaves the stored price alone: a PATCH that renamed the
     * product must not touch its price.
     */
    let nextBasePrice: number | undefined;
    if (basePrice !== undefined) {
      const read = readBasePrice(basePrice);
      if (read === null) {
        return NextResponse.json({ error: BASE_PRICE_NOT_A_NUMBER }, { status: 400 });
      }
      nextBasePrice = read;
    }

    // Price changes are a separate authority (products.change_price)
    if (nextBasePrice !== undefined && nextBasePrice !== existing.basePrice) {
      const priceAuth = authorize(user, 'products.change_price', existing);
      if (!priceAuth.allowed) {
        return NextResponse.json({ error: 'Forbidden: products.change_price', errorAr: 'تغيير السعر ليس من صلاحيّاتك. اطلبها من مدير النظام إن كانت من عملك.' }, { status: 403 });
      }
    }

    /*
     * «العرض ما بصير يكون اكثر من السعر الاساسي» — AND THE BASE PRICE IS THE LINE ITSELF.
     *
     * Lowering it lowers every offer's line at once, so a price that would leave a live offer above its line is
     * refused here, naming the offer, its price and the new line — after the price authority, so somebody who may
     * not change the price is told that first, and before anything is written. A raise, an unchanged price and a
     * zero pass without a question; the reasons are beside `baseBelowActiveOffersRefusal`.
     */
    if (nextBasePrice !== undefined) {
      const belowAnOffer = await baseBelowActiveOffersRefusal(db, existing, nextBasePrice, country.minorUnit);
      if (belowAnOffer) {
        return NextResponse.json({ error: belowAnOffer, code: 'BASE_BELOW_ACTIVE_OFFER' }, { status: 409 });
      }
    }

    // SKU uniqueness within company (excluding self)
    if (sku && sku.trim().toUpperCase() !== existing.sku) {
      const dup = await db.product.findFirst({
        where: { companyId, sku: sku.trim().toUpperCase(), id: { not: id } },
      });
      if (dup) {
        return NextResponse.json({ error: 'يوجد منتج آخر بنفس رمز SKU' }, { status: 400 });
      }
    }

    /**
     * A CATEGORY ID THAT DOES NOT RESOLVE IS AN ERROR, NOT A CLEARING.
     *
     * This first read `?? null`, so an id belonging to another tenant —
     * or a typo — quietly UNFILED the product and answered 200. A person
     * would see the category disappear and have no idea why. Clearing is
     * a real intention and has its own value: `null`.
     */
    let resolvedCategoryId: string | null = null;
    if (categoryId !== undefined && categoryId !== null) {
      const cat = await db.category.findFirst({
        where: { id: categoryId, companyId },
        select: { id: true },
      });
      if (!cat) return NextResponse.json({ error: 'لا تصنيف بهذا المعرّف' }, { status: 400 });
      resolvedCategoryId = cat.id;
    }

    /**
      * A READABLE ADDRESS, AND THE ONE IT REPLACES.
      *
      * Recomputed only when the NAME changes: an address that shifted
      * every time somebody edited a price would break links for no
      * reason anybody could explain.
      *
      * Unique within the store, because two shops may both sell
      * «كريم مرطّب» — and the old address is kept so the link that has
      * gone round a family group still arrives.
      */
    let addressing: { slug?: string | null; previousSlugs?: string | null } = {};
    if (name && name.trim() !== existing.name) {
      const wanted = slugify(name);
      if (wanted) {
        const siblings = await db.product.findMany({
          where: { storeId: existing.storeId, id: { not: existing.id }, slug: { not: null } },
          select: { slug: true },
        });
        const next = uniqueSlug(wanted, siblings.flatMap((s) => (s.slug ? [s.slug] : [])));
        if (next && next !== existing.slug) {
          addressing = {
            slug: next,
            previousSlugs: JSON.stringify(
              rememberSlug(parseHistory(existing.previousSlugs), existing.slug ?? '', next)
            ),
          };
        }
      }
    }

    const updated = await db.product.update({
      where: { id },
      data: {
        ...(name ? { name: name.trim() } : {}),
        ...(nameEn !== undefined ? { nameEn: nameEn?.trim() || null } : {}),
        ...(sku ? { sku: sku.trim().toUpperCase() } : {}),
        ...(description !== undefined ? { description: description?.trim() || null } : {}),
        ...(sourceType === 'PURCHASED' || sourceType === 'MANUFACTURED' ? { sourceType } : {}),
        ...(descriptionEn !== undefined ? { descriptionEn: descriptionEn?.trim() || null } : {}),
        /**
         * Its shelf. Absent leaves it alone; null clears it; an id is
         * checked against THIS company first — a category id in a request
         * body is a foreign key somebody can type, and filing a product
         * under another tenant's shelf would expose it to permissions
         * scoped to that shelf.
         */
        ...(categoryId !== undefined ? { categoryId: resolvedCategoryId } : {}),
        /**
         * WHAT KIND OF THING IT IS — this product's answers to its
         * category's questions.
         *
         * Read against that category's schema before being stored, so an
         * answer to a question nobody asks, or an option that was removed
         * from the list, never lands in the column. The parser is the same
         * one the storefront reads with, so what is saved here and what a
         * filter sees cannot be two different things.
         *
         * Absent leaves it alone. A product's answers are edited on their
         * own card, and a PATCH that renamed the product must not wipe
         * them.
         */
        ...(attributes !== undefined
          ? {
              attributes: JSON.stringify(
                parseProductAttributes(
                  JSON.stringify(attributes ?? {}),
                  parseCategoryAttributes(existing.category?.attributeSchema ?? null)
                )
              ),
            }
          : {}),
        // Read and refused above; a typed zero is stored as a zero.
        ...(nextBasePrice !== undefined ? { basePrice: nextBasePrice } : {}),
        ...(status ? { status } : {}),
        ...addressing,
      },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PRODUCT_UPDATED',
      entity: 'Product',
      entityId: id,
      previousData: { name: existing.name, sku: existing.sku, status: existing.status, basePrice: existing.basePrice },
      newData: { name: updated.name, sku: updated.sku, status: updated.status, basePrice: updated.basePrice },
    });

    await refreshLandingPages({ productId: id, companyId });
    return NextResponse.json({ success: true, product: updated });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}

/** DELETE — remove product and clean up all image files from storage */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();

    // This store's product only, the same reach as editing it.
    const product = await db.product.findFirst({
      where: { id, ...inStore(companyId, storeId) },
      include: { orders: { take: 1 }, images: true },
    });
    if (!product || product.companyId !== companyId) {
      return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });
    }

    // Scope-evaluated delete authorization (out-of-scope → 404)
    const deleteAuth = authorize(user, 'products.delete', product);
    if (!deleteAuth.allowed) {
      if (deleteAuth.reason === 'NO_TENANT' || deleteAuth.reason === 'OUT_OF_SCOPE') {
        return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });
      }
      return NextResponse.json({ error: 'Forbidden: missing required permission products.delete', errorAr: forbiddenAr('Forbidden: missing required permission products.delete') }, { status: 403 });
    }

    // Safety: block deletion when orders reference the product
    if (product.orders.length > 0) {
      return NextResponse.json(
        { error: 'لا يمكن حذف منتج مرتبط بطلبات — غيّر حالته إلى "غير نشط" بدلاً من الحذف' },
        { status: 400 }
      );
    }

    // Storage cleanup for every image
    for (const img of product.images) {
      await deleteStoredFile(img.storageKey);
    }

    await db.product.delete({ where: { id } });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PRODUCT_DELETED',
      entity: 'Product',
      entityId: id,
      previousData: { name: product.name, sku: product.sku, imagesRemoved: product.images.length },
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}
