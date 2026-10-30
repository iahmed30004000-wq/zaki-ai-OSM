import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, getPermissionScope } from '@/lib/authorization';
import { apiErrorResponse, forbiddenAr } from '@/lib/api-error';
import { maySeeCost } from '@/lib/cost-visibility';
import { productScopeWhereWithin } from '@/lib/product-scope';
import { getDateRange } from '@/lib/analytics';
import { CONFIRMATION_REFUSED, DELIVERED_SHIPPING } from '@/lib/order-state';
import {
  MIN_CONFIRMED_ORDERS,
  byProductGrade,
  catalogueReadiness,
  gradeProduct,
  type ProductGrade,
  type ProductSales,
} from '@/lib/product-grade';

/**
 * GET /api/products/grades?ids=… — the grade for the products on one page.
 *
 * A SEPARATE ROUTE FROM THE PRODUCTS LIST, and that is the whole reason it
 * exists. `GET /api/products` is read by the product picker on every order
 * form and by `useProducts` on several screens; hanging a join over every
 * order line off it would make every order form wait for a report. The same
 * split `/api/settings/channels/performance` makes for the same reason: the
 * names stay there, fast and open, and the numbers live here.
 *
 * BY ID LIST, DELIBERATELY. The products list owns the search, the
 * store scope and the unfiled filter; a second route re-deriving them would
 * drift and the grade beside a name would belong to another row. So the
 * screen loads its page and then asks about exactly the rows it is showing.
 * The ids are still filtered through the same `products.view` scope the list
 * uses, because an id in a query string is a request, not a permission.
 *
 * TWO GATES, TWO DIFFERENT QUESTIONS, AND NEITHER IS A 403.
 *
 *   May this caller see how the catalogue PERFORMS? `reports.view` — the
 *   key the performance and landing screens already use. Without it the row still answers the readiness question, because a
 *   missing price and a missing image are catalogue facts the products list
 *   already shows this caller in its own columns. The score half is then
 *   absent, not zeroed, and the row SAYS it is absent.
 *
 *   May this caller see what the goods COST? `maySeeCost` —
 *   `cost-visibility.ts` exists because this very endpoint once returned the
 *   margin on everything the company sells to anybody who could open the
 *   products screen. Without it the margin band is absent and the score is
 *   out of seventy, which the row prints.
 *
 * NOTHING HERE ASKS A MODEL. Every sentence the screen prints comes out of
 * `product-grade.ts` as a template around an integer counted below.
 */

/** The measured catalogue is 114 rows and the list does not page. */
const MAX_IDS = 200;

/** A parcel the door has sent back, or is sending back. `attribution-performance`'s own pair. */
const RETURNED_SHIPPING = ['RETURNED', 'RETURN_REQUESTED'] as const;

const DAY_MS = 86_400_000;

interface Tally {
  confirmed: number;
  delivered: number;
  returned: number;
  refused: number;
  revenue: number;
  cogs: number;
}

const empty = (): Tally => ({ confirmed: 0, delivered: 0, returned: 0, refused: 0, revenue: 0, cogs: 0 });

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();

    // The list's own gate, resolved to its effective scope, so a grade can
    // never be returned for a product the caller may not see.
    const scope = getPermissionScope(user, 'products.view');
    if (!scope) {
      return NextResponse.json({ error: 'Forbidden: missing required permission products.view', errorAr: forbiddenAr('Forbidden: missing required permission products.view') }, { status: 403 });
    }

    const asked = (new URL(req.url).searchParams.get('ids') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const ids = [...new Set(asked)].slice(0, MAX_IDS);

    const showSales = can(user, 'reports.view');
    const showCost = maySeeCost(user);

    // The same bounded window every report in this system uses for «الكل»:
    // ninety days, clamped server-side. An unbounded scan over order lines is
    // the one query that grows without limit as the shop trades.
    const { start, end } = getDateRange({ period: 'all' });
    const when = start && end ? { gte: start, lte: end } : undefined;
    const windowDays = start && end ? Math.round((end.getTime() - start.getTime()) / DAY_MS) : null;

    const meta = {
      window: { start: start ?? null, end: end ?? null, days: windowDays },
      minSample: MIN_CONFIRMED_ORDERS,
      salesVisible: showSales,
      costVisible: showSales && showCost,
    };

    if (ids.length === 0) {
      return NextResponse.json({ ...meta, grades: [], readiness: catalogueReadiness([]) });
    }

    // The catalogue rule the list reads, narrowed to the rows asked about (RV86: one function, not a third copy).
    const where = productScopeWhereWithin(scope, companyId, storeId, ids);

    const products = await db.product.findMany({
      where,
      select: {
        id: true,
        status: true,
        basePrice: true,
        categoryId: true,
        _count: { select: { images: true } },
      },
    });

    if (products.length === 0) {
      return NextResponse.json({ ...meta, grades: [], readiness: catalogueReadiness([]) });
    }

    /**
     * WHAT HAPPENED TO EVERY LINE IN THE STORE, ONCE.
     *
     * Not filtered to the asked ids, on purpose: the value band reads one
     * delivered order against the BEST product in the same shop, and a
     * reference taken from one page would rank a product against whichever
     * rows the reader happened to be looking at. The same reason
     * `/api/users/grades` scores a whole role rather than a page.
     *
     * It also makes the discount allocation exact rather than nearly so: an
     * order's share is a line's `lineTotal` over the order's WHOLE line
     * value, and the siblings are only in the result if nothing filters them
     * out. Measured: 0 of 171 orders carry a second line today, so a wrong
     * denominator would have been invisible until the day it mattered.
     */
    const lines = showSales
      ? await db.orderItem.findMany({
          where: { order: { companyId, ...(storeId ? { storeId } : {}), ...(when ? { createdAt: when } : {}) } },
          select: {
            productId: true,
            lineTotal: true,
            orderId: true,
            order: {
              select: {
                confirmationStatus: true,
                shippingStatus: true,
                totalAmount: true,
                collectedAmount: true,
                estimatedCostOfGoods: true,
              },
            },
          },
        })
      : [];

    // Each order's whole line value, to split its money between its lines.
    const orderLineValue = new Map<string, number>();
    for (const line of lines) {
      orderLineValue.set(line.orderId, (orderLineValue.get(line.orderId) ?? 0) + Number(line.lineTotal));
    }

    const tally = new Map<string, Tally>();
    for (const line of lines) {
      const o = line.order;
      const t = tally.get(line.productId) ?? empty();

      if (o.confirmationStatus === 'CONFIRMED') t.confirmed += 1;
      if ((CONFIRMATION_REFUSED as readonly string[]).includes(o.confirmationStatus)) t.refused += 1;
      if ((RETURNED_SHIPPING as readonly string[]).includes(o.shippingStatus)) t.returned += 1;

      if ((DELIVERED_SHIPPING as readonly string[]).includes(o.shippingStatus)) {
        const whole = orderLineValue.get(line.orderId) ?? 0;
        const share = whole > 0 ? Number(line.lineTotal) / whole : 1;
        t.delivered += 1;
        // The two-part revenue the profit screen and the attribution tables
        // both use: what the door actually collected where it recorded it,
        // and the order total where it did not. A second formula here is how
        // two screens end up disagreeing about one week.
        t.revenue += Number(o.collectedAmount ?? o.totalAmount) * share;
        t.cogs += Number(o.estimatedCostOfGoods ?? 0) * share;
      }

      tally.set(line.productId, t);
    }

    /**
     * THE BEST DELIVERED-ORDER VALUE IN THE SHOP — the money band's ceiling.
     *
     * Money has no natural ceiling, so `channel-score` reads it against the
     * best door and this reads it against the best product. Taken over the
     * whole store rather than the page, so the reference does not change
     * with what the reader happens to be looking at.
     *
     * AND ONLY OVER PRODUCTS THAT THEMSELVES CLEAR THE FLOOR — which is
     * where this parts company with the channels screen, for a reason that
     * was measured rather than argued. The highest delivered-order value in
     * this shop is 50.01, and it belongs to a product with TWO delivered
     * orders. Letting it set the ceiling scored the three real products 8, 9
     * and 9 out of the twenty-point band instead of 17, 19 and 20 — half the
     * band, lost to a two-order fluke. A sample too thin to be graded is too
     * thin to grade everybody else against.
     */
    let bestDeliveredValue: number | null = null;
    for (const t of tally.values()) {
      if (t.delivered <= 0 || t.revenue <= 0 || t.confirmed < MIN_CONFIRMED_ORDERS) continue;
      const value = t.revenue / t.delivered;
      if (bestDeliveredValue === null || value > bestDeliveredValue) bestDeliveredValue = value;
    }

    const grades: ProductGrade[] = products
      .map((p) => {
        const t = tally.get(p.id) ?? empty();
        const sales: ProductSales | null = showSales
          ? {
              confirmed: t.confirmed,
              delivered: t.delivered,
              returned: t.returned,
              refused: t.refused,
              deliveredRevenue: Number(t.revenue.toFixed(2)),
              // Absent, not zeroed: a zero is the claim «this cost nothing».
              deliveredCogs: showCost ? Number(t.cogs.toFixed(2)) : null,
              bestDeliveredValue,
            }
          : null;
        return gradeProduct({
          productId: p.id,
          catalogue: {
            status: p.status,
            basePrice: p.basePrice,
            imageCount: p._count.images,
            hasCategory: p.categoryId !== null,
          },
          sales,
        });
      })
      .sort(byProductGrade);

    return NextResponse.json({ ...meta, grades, readiness: catalogueReadiness(grades) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
