import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { apiErrorResponse, forbiddenAr } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requireContext } from '@/lib/geo-context';
import { logAudit } from '@/lib/audit';
import { productCosts } from '@/lib/product-cost';
import { fixedCostsOf } from '@/lib/product-fixed-cost';
import { requirePermission, getPermissionScope } from '@/lib/authorization';
import { maySeeCost, withoutCost } from '@/lib/cost-visibility';
import { productScopeWhere } from '@/lib/product-scope';
import { deliveredUnitsByProduct } from '@/lib/product-sold';
import { BASE_PRICE_NOT_A_NUMBER, readBasePrice } from '@/lib/product-base-price';
import { activeOffersForProducts, withTheReduction, type OfferView } from '@/lib/offers';

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();

    // Canonical gate — products.view, resolved to its effective scope so the
    // list query can filter at the SQL level (no JS filtering).
    const scope = getPermissionScope(user, 'products.view');
    if (!scope) {
      return NextResponse.json({ error: 'Forbidden: missing required permission products.view', errorAr: forbiddenAr('Forbidden: missing required permission products.view') }, { status: 403 });
    }

    // This store's catalogue. A store is a separate business here: its own
    // goods, its own stock, its own shelf. A product from another store
    // showing up in this list is one somebody could try to sell.
    // Scope → SQL filters (`productScopeWhere`, shared with the command palette): CATEGORY/SPECIFIC
    // read scopeIds that were tenant-validated when the grant was written; ALL_COMPANY / OWN add none.
    const where: Prisma.ProductWhereInput = productScopeWhere(scope, companyId, storeId);

    // Optional search (q) + limit for scope pickers / search UIs.
    // When absent the behavior is unchanged from before.
    const url = new URL(req.url);
    const q = url.searchParams.get('q')?.trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { nameEn: { contains: q, mode: 'insensitive' } },
        { sku: { contains: q, mode: 'insensitive' } },
      ];
    }
    const limitRaw = url.searchParams.get('limit');
    const take = limitRaw ? Math.min(Math.max(Number.parseInt(limitRaw, 10) || 0, 1), 100) : undefined;

    /**
     * HOW MANY ARE STILL UNFILED — counted over the same scope the list
     * uses, so the number and the rows can never disagree. Said out loud on
     * the screen, because 114 products with no category is a fact nobody
     * could see: the column simply rendered nothing.
     */
    const uncategorised = await db.product.count({ where: { ...where, categoryId: null } });

    const products = await db.product.findMany({
      where,
      take,
      include: {
        // The shelf's NAME, not just its id: a list that prints a uuid is
        // a list nobody reads.
        category: { select: { id: true, name: true } },
        images: {
          orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
        },
        batches: {
          select: {
            id: true,
            batchNumber: true,
            quantityProduced: true,
            quantitySold: true,
            quantityRemaining: true,
            totalProductionCost: true,
            costPerUnit: true,
            manufacturingCost: true,
            packagingCost: true,
            rawMaterialCost: true,
            otherCosts: true,
            productionDate: true,
          },
        },
        offers: {
          select: {
            id: true,
            name: true,
            quantity: true,
            /*
             * The free units the bundle gives. The order dialog reads its
             * offers from this list, so without the column it could not
             * show a gift, and the line it sent carried none — which is
             * how «٣+١» reached the warehouse as three.
             */
            freeQuantity: true,
            sellingPrice: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    /**
     * WHAT IT COST US IS NOT PART OF «WHAT IS THIS PRODUCT».
     *
     * `products.view` belongs to the moderator and the confirmation and
     * follow-up agents, who need the name, the price and the stock to talk
     * to a customer. This list was also sending them every batch's
     * manufacturing, packaging and raw-material cost and the average cost
     * per unit — the margin on everything the company sells. The rule is
     * the one the inventory route already applies.
     */
    const showCost = maySeeCost(user);

    /**
     * THE OFFERS ON SALE RIGHT NOW, BESIDE `offers` AND NOT INSTEAD OF IT.
     *
     * `offers` above is every row the product has — stopped, finished, the one shown only after an order — and a good
     * many screens read it as exactly that, so it is left word for word. `liveOffers` is the other question, «what
     * may be sold today»: the one reader every door uses (`activeOffersForProducts`), so a list that offers a bundle
     * to somebody pricing a line offers only one the doors would accept. `price` in it is what the customer is charged
     * (after the bundle's own reduction); `listPrice` is the figure before it, or null; `discount` is the difference.
     *
     * BEST-EFFORT, and it must stay so: an extra field is no reason for the catalogue not to load. When the read fails
     * the key is simply absent, which every reader treats as «no live offer known».
     */
    let liveOf: Map<string, OfferView[]> | null = null;
    try {
      liveOf = await activeOffersForProducts(db, companyId, products.map((p) => p.id), country.minorUnit, new Date(), {
        withEvidence: false,
      });
    } catch {
      liveOf = null;
    }

    /**
     * ONE «متوسط تكلفة الوحدة», AND IT IS THE ONE product-cost.ts OWNS.
     *
     * This used to be computed here by hand as `totalProductionCost /
     * totalProduced` across EVERY batch — including the ones already
     * emptied. `product-cost.ts` says in as many words why that is the
     * wrong number: «an emptied run tells you what March cost, not what a
     * unit costs today, and averaging it back in drags the figure towards
     * a price you can no longer buy at».
     *
     * So the same product page carried two different figures under nearly
     * the same Arabic label — this one in the information card, and the
     * weighted average of stock ON HAND in the stock panel beside it.
     * They agree on every product whose stock arrived at one price, and
     * disagree the moment one is re-received at another, which is exactly
     * the case somebody opens that page to understand.
     *
     * One query for the whole page, not one per product.
     */
    /**
     * «SOLD» IS WHAT THE CUSTOMERS TOOK, NOT THE BATCH COUNTER (RV87).
     *
     * `analytics.totalSold` used to be the sum of `quantitySold` over the batches, a counter that only moves when a
     * delivery draws from a batch — it read 0 for 13 of the 14 products that had delivered units. It is the delivered
     * lines now, counted in the database by the one function the stats door and the product page also use, and asked in
     * the same round as the cost. Units only: no price and no cost is touched.
     */
    const [costOf, soldOf, fixedOf] = await Promise.all([
      showCost
        ? productCosts(db, companyId, products.map((p) => p.id))
        : Promise.resolve(new Map<string, { average: number }>()),
      deliveredUnitsByProduct(db, { companyId, storeId, productIds: products.map((p) => p.id) }),
      // The figure an admin set, for those who may see a cost: it is the unit cost of a product that has one.
      showCost ? fixedCostsOf(db, companyId, products.map((p) => p.id)) : Promise.resolve(new Map<string, number>()),
    ]);

    // Compute comprehensive cost analysis for each product
    const enriched = products.map((prod) => {
      const totalProduced = prod.batches.reduce((sum, b) => sum + b.quantityProduced, 0);
      const totalSold = soldOf.get(prod.id) ?? 0;
      const totalRemaining = prod.batches.reduce((sum, b) => sum + b.quantityRemaining, 0);

      const totalMfgCost = prod.batches.reduce((sum, b) => sum + b.manufacturingCost, 0);
      const totalPackCost = prod.batches.reduce((sum, b) => sum + b.packagingCost, 0);
      const totalRawCost = prod.batches.reduce((sum, b) => sum + b.rawMaterialCost, 0);
      const totalOtherCost = prod.batches.reduce((sum, b) => sum + b.otherCosts, 0);
      const totalProdCost = prod.batches.reduce((sum, b) => sum + b.totalProductionCost, 0);


      return {
        ...prod,
        ...(liveOf ? { liveOffers: (liveOf.get(prod.id) ?? []).map((o) => withTheReduction(o, country.minorUnit)) } : {}),
        // The batches keep their quantities and dates for everybody; their
        // money is dropped, not zeroed — a zero is a claim, and «this cost
        // nothing» is a false one.
        batches: showCost ? prod.batches : prod.batches.map(withoutCost),
        analytics: {
          totalProduced,
          totalSold,
          totalRemaining,
          ...(showCost
            ? {
                totalMfgCost,
                totalPackCost,
                totalRawCost,
                totalOtherCost,
                totalProdCost,
                // The unit cost: the fixed figure an admin set where there is one, else the weighted average of the stock
                // actually on hand — the one figure, from the one owner. `fixedCost` says which of the two it is (null: the average).
                avgCostPerUnit: Number((fixedOf.get(prod.id) ?? costOf.get(prod.id)?.average ?? 0).toFixed(2)),
                fixedCost: fixedOf.get(prod.id) ?? null,
              }
            : {}),
        },
      };
    });

    return NextResponse.json({ products: enriched, uncategorised });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('products.create');

    const body = await req.json();
    const { name, nameEn, sku, description, descriptionEn, basePrice, status, sourceType, categoryId } = body;

    if (!name || !sku) {
      return NextResponse.json({ error: 'الاسم ورمز المنتج مطلوبان' }, { status: 400 });
    }

    /**
     * A PRICE THAT IS NOT A NUMBER IS AN ERROR, NOT A FREE PRODUCT.
     *
     * This used to be `parseFloat(basePrice) || 0` inside the `create`
     * block. A price box holding anything non-numeric stored a product at
     * **zero** and answered 200 — and `basePrice` is what the landing page
     * shows a shopper, what the AI intake falls back to, and what the offer
     * ladder multiplies.
     *
     * Absent is its own case and stays allowed: the column's default is
     * `0.0` and a catalogue entry may legitimately be priced later. What is
     * refused is a value that WAS sent and is not a price. The reader is
     * shared with the edit door so the two cannot drift — see
     * `product-base-price.ts`.
     */
    let resolvedBasePrice = 0;
    if (basePrice !== undefined) {
      const read = readBasePrice(basePrice);
      if (read === null) {
        return NextResponse.json({ error: BASE_PRICE_NOT_A_NUMBER }, { status: 400 });
      }
      resolvedBasePrice = read;
    }

    /**
     * AND A SHELF TO FILE IT ON.
     *
     * Measured before this: 114 products, and not one of them categorised.
     * A field that may be left empty is left empty, and the emptiness is
     * not cosmetic — permissions can be scoped to categories, the assistant
     * reads a product's category to answer «أي صنفٍ يبيع أكثر», and every
     * report that groups by category grouped everything into one heap.
     *
     * It is demanded on the way IN, where it costs one click and the picker
     * can name a new shelf on the spot. The products already here are not
     * held hostage to it: editing one does not demand a category it never
     * had, and the screen counts them so the backlog is visible instead of
     * silent. Blocking an edit until somebody files 114 products is how a
     * rule gets worked around rather than followed.
     */
    if (!categoryId) {
      return NextResponse.json(
        {
          error:
            'اختر تصنيف المنتج. التصنيف يُستعمل في صلاحيات الوصول وفي تقارير الأصناف وفي إجابات المساعد — ' +
            'ويمكنك إنشاء تصنيفٍ جديدٍ من المنتقي نفسه.',
          code: 'CATEGORY_REQUIRED',
        },
        { status: 400 }
      );
    }

    // A SKU identifies an article WITHIN A STORE. It was unique across the
    // company, so two stores could not carry the same article under the
    // code the supplier prints on the box.
    const existing = await db.product.findFirst({
      where: { companyId, storeId, sku: sku.trim().toUpperCase() },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json({ error: 'A product with this SKU already exists', errorAr: 'رمز المنتج (SKU) مستعملٌ. اختر رمزاً أخر.' }, { status: 400 });
    }

    // An id that does not resolve is refused rather than dropped: filing
    // a product under a shelf that does not exist should say so, not
    // quietly create it unfiled.
    const cat = await db.category.findFirst({
      where: { id: categoryId, companyId },
      select: { id: true },
    });
    if (!cat) return NextResponse.json({ error: 'لا تصنيف بهذا المعرّف' }, { status: 400 });
    const resolvedCategoryId = cat.id;

    const product = await db.product.create({
      data: {
        companyId,
        // From the session, never the body: a body that names its own store
        // is a body that can name someone else's.
        storeId,
        name: name.trim(),
      nameEn: nameEn?.trim() || null,
      descriptionEn: descriptionEn?.trim() || null,
        sku: sku.trim().toUpperCase(),
        description: description?.trim(),
        // Read and refused above. A typed zero is stored as a zero.
        basePrice: resolvedBasePrice,
        // Which door this product's stock comes in through. Both write the
        // same ledger; this only decides which form you are shown, and a
        // ready-made good entered as a "production run" corrupts the
        // production cost reports.
        sourceType: sourceType === 'PURCHASED' ? 'PURCHASED' : 'MANUFACTURED',
        status: status || 'ACTIVE',
        /**
         * The shelf it sits on. Verified to belong to THIS company before
         * it is written: a category id from a request body is a foreign
         * key somebody can type, and a product filed under another
         * tenant's shelf would be visible to permissions scoped to it.
         */
        categoryId: resolvedCategoryId,
      },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PRODUCT_CREATED',
      entity: 'Product',
      entityId: product.id,
      newData: product,
    });

    return NextResponse.json({ success: true, product });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}
