import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { preparationGroups } from '@/lib/operations';
import { isBenchStore } from '@/lib/bench-store';
import { BENCH_LIST_EMPTY_AR } from '@/lib/test-store';
import { ShipmentPlaceRefused, shipmentPlace, shipmentPlaceBody } from '@/lib/shipment-warehouse';
import { reachesWarehouse } from '@/lib/warehouses';

/**
 * GET /api/ops/preparation — confirmed orders grouped BY PRODUCT with
 * orders / required / available / shortage per product, and the lines under
 * it. Availability honours the country's allow_negative_stock flag, which is
 * returned so the screen can say which shortages block shipment.
 */
export async function GET(req?: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('ops.prepare');

    // A bench's orders stop at confirmation (`test-store.ts`): nothing to pack, and the screen says why.
    if (await isBenchStore(db, { companyId, storeId })) {
      return NextResponse.json({
        allowNegativeStock: country.allowNegativeStock,
        totals: { products: 0, orders: 0, shortages: 0 },
        groups: [],
        benchNote: BENCH_LIST_EMPTY_AR,
      });
    }

    /*
     * W4a: «available» of one warehouse of a placed store, with `?warehouse=` (one she reaches). Not read for a store that
     * is not placed, and absent = the store's shelf, as before.
     */
    const askedWarehouse = req ? new URL(req.url).searchParams.get('warehouse') : null;
    const place = askedWarehouse
      ? await shipmentPlace(db, { companyId, storeId, warehouseId: askedWarehouse, mayUse: (w) => reachesWarehouse(user, companyId, w) })
      : null;
    const groups = place ? await preparationGroups(db, { companyId, storeId }, { warehouse: place }) : await preparationGroups(db, { companyId, storeId });

    return NextResponse.json({
      allowNegativeStock: country.allowNegativeStock,
      totals: {
        products: groups.length,
        orders: new Set(groups.flatMap((g) => g.lines.map((l) => l.orderId))).size,
        shortages: groups.filter((g) => g.shortage > 0).length,
      },
      groups,
    });
  } catch (error) {
    if (error instanceof ShipmentPlaceRefused) return NextResponse.json(shipmentPlaceBody(error), { status: error.status });
    return apiErrorResponse(error);
  }
}
