import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/types/auth';
import { storeIsPlaced } from './warehouse-intake';
import { warehousesOfStore, warehousesReachedBy } from './warehouses';

/**
 * «من أي مخزن طلع المرتجع» — THE RETURNS DESK'S WAREHOUSE FILTER (the owner, 25/11: «اسم المخزن أظهره بمتابعة المرتجعات
 * عشان أعرف، واعمل فلتر من أي مخزن طلع المرتجع»).
 *
 *   ?warehouse=<id>     only the parcels that LEFT FROM this warehouse (`Order.sourceWarehouseId`, stamped as the order
 *                       joins a shipping batch of a placed store — `shipment-warehouse.ts`, W4a)
 *   ?warehouse=none     «بلا مخزن»: the parcels with no stamp. A placed store has them: everything that was shipped
 *                       before its placement, and an order of a trolley opened before it, carries none.
 *   absent / all       no filter
 *
 * A STORE THAT IS NOT PLACED: the parameter is not read. Nothing is asked of the warehouse tables, nothing is narrowed,
 * and the answer is the one `osm/main` gave (only the placement itself is asked, and only when the URL carries the
 * parameter at all — the screen of an unplaced store never sends it).
 *
 * A PLACED STORE: a warehouse id must be one of the warehouses the desk's own picker offers — the running warehouses of
 * the store's country that this person reaches (`warehousesOfStore` + `warehousesReachedBy`, the rule of the shipping
 * screens' picker and of `/api/ops/returns/warehouses`). Any other value is REFUSED with a 400 in Arabic, as the desk
 * refuses every value it does not know (`returns-filters.ts`): a quiet «everything» would answer a question nobody asked.
 *
 * Read only: the answer is one `where` clause on `sourceWarehouseId` and nothing else. No stock, no money, no write.
 * The question rides on the indexes the list already uses (`[companyId, shippingStatus]` for the waiting parcels, the
 * receipt's unique `orderId` for the counted ones) and on `@@index([sourceWarehouseId])`.
 */

/** «بلا مخزن» — the parcels that carry no warehouse stamp. */
export const NO_WAREHOUSE = 'none';
export const RETURNS_WAREHOUSE_REFUSED = 'RETURNS_WAREHOUSE_UNKNOWN';
const REFUSAL_AR = 'المخزن غير معروف أو مش من المخازن اللي بتوصللها — اختار مخزن من القائمة.';

export type ReturnsWarehouseFilter =
  | { ok: true; clause: Prisma.OrderWhereInput | null; warehouse: string | null }
  | { ok: false; body: { error: string; errorAr: string; code: string } };

const NOTHING: ReturnsWarehouseFilter = { ok: true, clause: null, warehouse: null };

export async function returnsWarehouseFilter(
  params: URLSearchParams,
  input: { user: SessionUser; companyId: string; storeId: string },
): Promise<ReturnsWarehouseFilter> {
  const raw = params.get('warehouse')?.trim();
  if (!raw || raw === 'all') return NOTHING;
  // An unplaced store: the parameter does not exist for it.
  if (!(await storeIsPlaced(input.storeId))) return NOTHING;
  if (raw === NO_WAREHOUSE) return { ok: true, clause: { sourceWarehouseId: null }, warehouse: NO_WAREHOUSE };
  const own = await warehousesOfStore(input.companyId, input.storeId);
  const reached = await warehousesReachedBy(input.user, input.companyId, own.map((w) => ({ ...w, companyId: input.companyId })));
  if (!reached.some((w) => w.id === raw)) {
    return { ok: false, body: { error: REFUSAL_AR, errorAr: REFUSAL_AR, code: RETURNS_WAREHOUSE_REFUSED } };
  }
  return { ok: true, clause: { sourceWarehouseId: raw }, warehouse: raw };
}
