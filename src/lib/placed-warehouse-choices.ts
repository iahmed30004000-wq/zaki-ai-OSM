import { db } from './db';
import { storeIsPlaced } from './warehouse-intake';
import { warehousesOfStore, warehousesReachedBy } from './warehouses';
import type { SessionUser } from '@/types/auth';

/**
 * WHICH WAREHOUSE A SCREEN OFFERS — for a store placed in warehouses only (22/11, F1: the owner's «صلحها»).
 *
 * The production run and the options' count of a placed store must name a warehouse (`warehouse-intake.intakePlace`,
 * `variant-stock.countPlace`). The screen offers exactly what those doors accept: the running warehouses of the store's
 * country that this person reaches (`warehousesOfStore` + `warehousesReachedBy` — the very list `GET /api/inventory`
 * marks `mayReceive`, W2c). No arithmetic in the browser.
 *
 *   null                                   the store is not placed: the screen asks nothing new and sends nothing new
 *   { warehouses, defaultWarehouseId }     the choices, and the one chosen for her:
 *        - the warehouse she keeps (`user_warehouse_access`), when she keeps exactly one of them;
 *        - otherwise the only choice, when there is only one (as the receive dialog does);
 *        - otherwise null — a required choice.
 *
 * Reads nothing more for a store that is not placed than «is it placed?».
 */
export interface PlacedWarehouseChoices {
  warehouses: { id: string; name: string }[];
  defaultWarehouseId: string | null;
}

export async function placedWarehouseChoices(
  user: SessionUser,
  companyId: string,
  storeId: string | null | undefined
): Promise<PlacedWarehouseChoices | null> {
  if (!storeId || !(await storeIsPlaced(storeId))) return null;
  const own = await warehousesOfStore(companyId, storeId);
  const reached = await warehousesReachedBy(user, companyId, own.map((w) => ({ ...w, companyId })));
  const ids = reached.map((w) => w.id);
  const kept =
    ids.length > 0
      ? await db.userWarehouseAccess.findMany({ where: { userId: user.id, warehouseId: { in: ids } }, select: { warehouseId: true } })
      : [];
  const keeps = [...new Set(kept.map((k) => k.warehouseId))];
  const defaultWarehouseId = keeps.length === 1 ? keeps[0] : reached.length === 1 ? reached[0].id : null;
  return { warehouses: reached.map((w) => ({ id: w.id, name: w.name })), defaultWarehouseId };
}
