import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { reachesWarehouse, storeIsPlaced, warehousesOfStore } from '@/lib/warehouses';
import { refuse } from '@/lib/placement-door';
import { placesOf } from '@/lib/stock-places';
import { figureOf, warehouseHolds } from '@/lib/warehouse-figures';

/**
 * GET /api/inventory/shelf?warehouse=<id> (inventory.view) — one warehouse of the caller's store, product by product:
 * «على الرف · محجوز · متاح». The transfer form says «المتاح» beside the quantity from this (the owner, 27/11: «النقل من
 * المتاح»); the transfer door judges the press by the same terms (`stock-transfers.freeStockOf`). Read only.
 */
export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.view');

    const warehouseId = new URL(req.url).searchParams.get('warehouse')?.trim() ?? '';
    const warehouses = (await storeIsPlaced(storeId)) ? await warehousesOfStore(companyId, storeId) : [];
    const asked = warehouses.find((w) => w.id === warehouseId);
    if (!asked) return refuse(404, 'WAREHOUSE_NOT_FOUND', 'المخزن مش موجود. حدّث الصفحة.');
    // A warehouse she sends from is one she reaches: a keeper is not told another warehouse's shelf by this door.
    if (!(await reachesWarehouse(user, companyId, { ...asked, companyId }))) {
      return refuse(403, 'WAREHOUSE_NOT_REACHED', 'ما إلك وصول على هالمخزن.');
    }

    const rows = await db.productionBatch.findMany({
      where: { companyId, storeId, warehouseId, inTransitTransferId: null },
      select: { productId: true, quantityRemaining: true, warehouseId: true, inTransitTransferId: true },
    });
    const productIds = [...new Set(rows.map((r) => r.productId))];
    const holds = (await warehouseHolds(db, { companyId, storeId, warehouseIds: [warehouseId], productIds })).get(warehouseId);
    const products = Object.fromEntries(
      productIds.map((id) => {
        const onHand = placesOf(rows.filter((r) => r.productId === id)).warehouses[0]?.onHand ?? 0;
        return [id, figureOf(onHand, holds?.get(id))];
      })
    );
    return NextResponse.json({ warehouseId, products });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
