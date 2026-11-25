import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { storeIsPlaced } from '@/lib/warehouse-intake';
import { warehousesOfStore, warehousesReachedBy } from '@/lib/warehouses';

/**
 * GET /api/ops/returns/warehouses — WHERE A PARCEL MAY BE RECEIVED (the warehouse plan, W2b).
 *
 *   { placed: false }                                    a store that is not placed: the desk asks nothing new
 *   { placed: true, warehouses: [{ id, name }, …] }      the running warehouses of the store's country this person reaches
 *
 * Its own door, and not a key of the returns list's answer, on purpose: that list is pinned question for question to what
 * it asked before warehouses existed (`an-order-says-where-it-left-from.test.ts`), and the desk needs this once, not per
 * page. The list is the rule the receipt itself asks (`warehouse-intake.returnPlace` → `warehouses.reachesWarehouse`), so
 * the dialog offers no warehouse the door would refuse. Asked of the returns key, like the desk.
 */
export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('ops.returns');
    if (!(await storeIsPlaced(storeId))) return NextResponse.json({ placed: false });
    const own = await warehousesOfStore(companyId, storeId);
    const reached = await warehousesReachedBy(user, companyId, own.map((w) => ({ ...w, companyId })));
    return NextResponse.json({ placed: true, warehouses: reached.map((w) => ({ id: w.id, name: w.name })) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
