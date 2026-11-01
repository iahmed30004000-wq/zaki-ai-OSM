import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { inStore } from '@/lib/store-filter';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { maySeeCost } from '@/lib/cost-visibility';
import { apiErrorResponse } from '@/lib/api-error';
import { productCost } from '@/lib/product-cost';
import { fixedCostsOf, withFixedCost } from '@/lib/product-fixed-cost';
import { reservedElsewhere } from '@/lib/reservation';

/**
 * GET /api/products/[id]/stock — what this product has and what it cost.
 *
 * Every number is derived at read time from the batches and the open orders.
 * There is no stored on-hand column and no stored cost, so there is nothing
 * to fall out of step with the ledger and nothing to correct — the same rule
 * the order state and the zone follow.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('inventory.view');
    // The quantities are the stock key's; what they cost is the cost key's (PR-10) — omitted, not zeroed, for the rest.
    const showCost = maySeeCost(user);
    const { id } = await ctx.params;

    const product = await db.product.findFirst({
      where: { id, ...inStore(companyId, storeId) },
      select: { id: true, sourceType: true },
    });
    if (!product) return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });

    const [batchCost, reserved, fixedOf] = await Promise.all([
      productCost(db, companyId, product.id),
      reservedElsewhere(db, companyId, product.id),
      // Only for somebody who may see a cost: the figure an admin set is a cost like any other.
      showCost ? fixedCostsOf(db, companyId, [product.id]) : Promise.resolve(new Map<string, number>()),
    ]);
    // With a fixed figure the unit cost, the next unit out and the value of the stock are IT; without one, exactly the batches' answer.
    const fixed = fixedOf.get(product.id);
    const cost = withFixedCost(batchCost, fixed);

    return NextResponse.json({
      onHand: cost.onHand,
      reserved,
      // What a new order may still take. Negative is possible and is not
      // hidden: it means open orders have promised goods that are not there,
      // and rounding it up to zero would hide the shortage from the one
      // person who can still fix it.
      available: cost.onHand - reserved,
      ...(showCost ? { averageCost: cost.average, nextOutCost: cost.nextOut, stockValue: cost.stockValue } : {}),
      // The fixed figure itself (null: none set yet), and what the batches say beside it — the admin sets one from the other. Same gate.
      ...(showCost ? { fixedCost: fixed ?? null, batchAverageCost: batchCost.average } : {}),
      batchCount: cost.batchCount,
      currencyCode: country.currencyCode,
      sourceType: product.sourceType === 'PURCHASED' ? 'PURCHASED' : 'MANUFACTURED',
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
