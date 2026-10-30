import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { getPermissionScope } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { maySeeCost } from '@/lib/cost-visibility';
import { mayReadInsights } from '@/lib/insights-key';
import { productCosts } from '@/lib/product-cost';
import { DELIVERED_SHIPPING } from '@/lib/order-state';
import { summariseProducts } from '@/lib/product-stats';

/**
 * GET /api/products/stats — the figures above the products list and the units in its «المبيعات» column.
 *
 * `lib/product-stats.ts` says what each figure is and why the column could not keep reading the batch counter. This is
 * the read that feeds it, and it is a SEPARATE door from `GET /api/products` for the reason `/grades` is: that list is
 * read by the product picker on every order form and by `useProducts` on several screens, and a join over every order
 * line hung off it would make every order form wait for a report. Names stay there, fast and open; the numbers live here.
 *
 * THE SAME CATALOGUE AS THE LIST, TO THE LETTER. The `where` below is the list's own — the store when one is selected,
 * the company when none is, and the CATEGORY / SPECIFIC grants as filters — so «١١٤ منتجاً» above the table and the rows
 * under it can never be two different catalogues. The gate is the list's gate: `products.view`.
 *
 * WHAT IS SENT, AND WHAT IS NOT. Units and counts go to everyone who may see the catalogue — the list already prints the
 * stock beside every name. The VALUE of the stock is what the goods cost, so it is sent only to a caller who may see cost
 * (`maySeeCost`), and is ABSENT for the rest: a zero is the claim «this stock cost nothing».
 *
 * THE UNITS ARE COUNTED IN THE DATABASE, not in JavaScript: two `groupBy`s over the order lines of delivered orders,
 * one row per product coming back whatever the shop has traded. The lines the door settled (`deliveredQty` set) count by
 * what the customer kept; the lines it did not count `quantity + freeQuantity`.
 */
export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();

    const scope = getPermissionScope(user, 'products.view');
    if (!scope) {
      // In Arabic in BOTH fields: a new door adds no English refusal (`arabic-refusals.test.ts` only lets that number fall).
      return NextResponse.json(
        { error: 'لا تملك صلاحية عرض المنتجات.', errorAr: 'لا تملك صلاحية عرض المنتجات.' },
        { status: 403 }
      );
    }

    const where: Prisma.ProductWhereInput = { companyId, ...(storeId ? { storeId } : {}) };
    if (scope.scope === 'CATEGORY') {
      where.categoryId = { in: Array.isArray(scope.scopeIds) ? (scope.scopeIds as string[]) : [] };
    } else if (scope.scope === 'SPECIFIC') {
      where.id = { in: Array.isArray(scope.scopeIds) ? (scope.scopeIds as string[]) : [] };
    }

    const products = await db.product.findMany({ where, select: { id: true, status: true, categoryId: true } });
    const ids = products.map((p) => p.id);
    const showCost = maySeeCost(user);

    // The lines of orders that reached the door as delivered, for THESE products in THIS store.
    const delivered = {
      companyId,
      productId: { in: ids },
      order: { companyId, ...(storeId ? { storeId } : {}), shippingStatus: { in: [...DELIVERED_SHIPPING] } },
    };

    const [costs, settled, unsettled] =
      ids.length === 0
        ? [new Map(), [], []]
        : await Promise.all([
            productCosts(db, companyId, ids),
            db.orderItem.groupBy({ by: ['productId'], where: { ...delivered, deliveredQty: { not: null } }, _sum: { deliveredQty: true } }),
            db.orderItem.groupBy({ by: ['productId'], where: { ...delivered, deliveredQty: null }, _sum: { quantity: true, freeQuantity: true } }),
          ]);

    const unitsSold = new Map<string, number>();
    for (const row of settled) {
      unitsSold.set(row.productId, (unitsSold.get(row.productId) ?? 0) + (row._sum.deliveredQty ?? 0));
    }
    for (const row of unsettled) {
      unitsSold.set(row.productId, (unitsSold.get(row.productId) ?? 0) + (row._sum.quantity ?? 0) + (row._sum.freeQuantity ?? 0));
    }

    const answer = summariseProducts({
      products,
      onHand: new Map([...costs].map(([id, c]) => [id, c.onHand])),
      stockValue: showCost ? new Map([...costs].map(([id, c]) => [id, c.stockValue])) : null,
      unitsSold,
    });

    // THE CARDS ABOVE THE LIST (`totals`, `top`) ARE SMART CARDS (PR-10): ABSENT, not zero, without `insights.view`. The units
    // in each row's «المبيعات» column are the catalogue's own figure — they stay for everybody who may see the catalogue.
    return NextResponse.json(mayReadInsights(user) ? answer : { unitsSold: answer.unitsSold });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
