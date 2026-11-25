/**
 * WHERE A PRODUCT'S UNITS ARE — the balances screen's per-warehouse figures (the warehouse plan, W2c).
 *
 * Pure: the batches the balances door already read, in; the figures, out. No database, no money, no arithmetic in a
 * screen — the screen prints what this returns.
 *
 * Units live only in batches (`receiving.ts`), and after a store's opening placement every batch row is in one of three
 * states (`batch-split.ts`, `warehouse-placement.ts`):
 *
 *   in a warehouse   `warehouseId` set                                  → that warehouse's figure
 *   on the road      `warehouseId` NULL, `inTransitTransferId` set       → «بالطريق»
 *   with no place    `warehouseId` NULL, no transfer                     → «بلا مكان» — the units that were out with the
 *                                                                         courier when the store was placed stay so
 *
 * The three add up to the store's «على الرف» exactly, because they are the same rows summed in three groups. That sum is
 * the store total the screen printed before the warehouses existed, and it is not recomputed from these figures: the
 * door keeps sending `remaining` as it always did.
 */

export interface PlaceRow {
  quantityRemaining: number;
  warehouseId?: string | null;
  inTransitTransferId?: string | null;
}

export interface ProductPlaces {
  /** Units per warehouse, in the order of the warehouses given, then any other warehouse a row names. Zeros left out. */
  warehouses: { id: string; onHand: number }[];
  /** Units on the road between two warehouses of this store. */
  inTransit: number;
  /** Units in rows with no place and no transfer. */
  unplaced: number;
}

export function placesOf(rows: readonly PlaceRow[], warehouseOrder: readonly string[] = []): ProductPlaces {
  const per = new Map<string, number>();
  let inTransit = 0;
  let unplaced = 0;
  for (const r of rows) {
    if (r.warehouseId) per.set(r.warehouseId, (per.get(r.warehouseId) ?? 0) + r.quantityRemaining);
    else if (r.inTransitTransferId) inTransit += r.quantityRemaining;
    else unplaced += r.quantityRemaining;
  }
  const order = [...warehouseOrder, ...[...per.keys()].filter((id) => !warehouseOrder.includes(id))];
  const warehouses = order
    .filter((id) => (per.get(id) ?? 0) !== 0)
    .map((id) => ({ id, onHand: per.get(id)! }));
  return { warehouses, inTransit, unplaced };
}

export interface ShownPlaces {
  warehouses: { id: string; onHand: number }[];
  inTransit: number;
  /** Units of this store's orders that have left and still hold their reservation (`warehouse-placement.unitsWithCourier`). */
  withCourier: number;
  /**
   * Units in rows with no place — SENT ONLY WHEN IT IS NOT the courier figure. Right after the placement the two are the
   * same units (the placement leaves exactly the courier's units unplaced), and printing both would read as twice as many.
   * They part once deliveries draw from the oldest rows, which have places (the draw by warehouse is a later request): then
   * the book holds units with no place that are not with the courier, and the screen says so.
   */
  unplaced?: number;
}

/** What the balances card prints for a placed store: the places, and the courier's units beside them. */
export function shownPlaces(p: ProductPlaces, withCourier: number): ShownPlaces {
  return {
    warehouses: p.warehouses,
    inTransit: p.inTransit,
    withCourier,
    ...(p.unplaced !== withCourier ? { unplaced: p.unplaced } : {}),
  };
}
