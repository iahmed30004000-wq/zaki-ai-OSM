/**
 * «طلع من مخزن كذا» — THE NAME OF THE WAREHOUSE AN ORDER LEFT FROM (the warehouse plan, request W4d).
 *
 * `Order.sourceWarehouseId` is stamped when the order joins a shipping batch in a PLACED store and cleared when it
 * leaves the trolley (`shipment-warehouse.ts`, W4a). Three screens say it: the order window, the tracking row and the
 * returns desk (there as the default receiver — DISPLAY ONLY: choosing the receiving warehouse is a later request).
 *
 * THE NAME COMES FROM THE SERVER, AS ONE OPTIONAL FIELD: `sourceWarehouseName`, present only when the order has a
 * source warehouse. An order with none — every order of a store that is not placed — gets no new key and costs no new
 * read: `sourceWarehouseNames` asks the database nothing when there is no id to ask about, so an unplaced store's
 * answers are byte for byte what they were.
 *
 * Read only. Nothing here writes, and nothing here reads stock, money or a customer.
 */

/** The one read this needs — narrow, so a test hands in a two-line fake. */
export interface WarehouseNameReader {
  warehouse: {
    findMany(args: {
      where: { companyId: string; id: { in: string[] } };
      select: { id: true; name: true };
    }): Promise<{ id: string; name: string }[]>;
  };
}

/**
 * The names of the warehouses these orders left from, by id — of THIS company only (another company's id finds
 * nothing). No id, no read.
 */
export async function sourceWarehouseNames(
  client: WarehouseNameReader,
  companyId: string,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (wanted.length === 0) return new Map();
  const rows = await client.warehouse.findMany({
    where: { companyId, id: { in: wanted } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * A row as it goes on the wire: the id that was selected only to find the name is taken off, and the name is added
 * only when there is one. A row with no source warehouse leaves exactly as it would have without this.
 */
export function withSourceWarehouseName<T extends { sourceWarehouseId?: string | null }>(
  row: T,
  names: ReadonlyMap<string, string>,
): Omit<T, 'sourceWarehouseId'> & { sourceWarehouseName?: string } {
  const { sourceWarehouseId, ...rest } = row;
  const name = sourceWarehouseId ? names.get(sourceWarehouseId) : undefined;
  return name ? { ...rest, sourceWarehouseName: name } : rest;
}
