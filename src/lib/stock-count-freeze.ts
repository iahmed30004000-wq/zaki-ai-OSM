import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';

type Reader = Pick<Prisma.TransactionClient | typeof prismaDb, 'stockCount'>;

/**
 * A WAREHOUSE UNDER COUNT STANDS STILL (the warehouse plan, request W5a).
 *
 * While a count sheet of a warehouse is OPEN (the keeper is counting) or SUBMITTED (it waits for a second person), its
 * expected figure must mean what the keeper found. So the warehouse refuses every door that would put units on its
 * shelf or take them off by hand: a receipt and a production run (`warehouse-intake.checkedWarehouse`, which every
 * intake asks — the receive door, the production run, the return desk, a transfer that lands from another store, the
 * quick count and a combination's count), a transfer sent from it, received into it or cancelled back to it
 * (`stock-transfers.ts`), and an exit asked or approved from it (`stock-exits.ts`).
 *
 * DELIVERIES GO ON: a parcel that is delivered was already with the courier — it leaves the book and the units «with the
 * courier» together, so the expected figure (`warehouse-count.expectedInWarehouse` = book − with the courier) does not
 * move, and the approval applies the DIFFERENCE (counted − frozen expected), never «set the shelf to what was counted».
 *
 * THE RACE WITH THE OPENING: the sheet is opened under the warehouse row FOR UPDATE; every door above reads the row FOR
 * SHARE before it asks this. A door that went first is finished before the sheet exists; one that comes second sees it.
 *
 * Every caller asks only after it knows the store is placed in warehouses — a store that is not placed has no count
 * sheet and reads nothing here.
 */

/** The statuses of a sheet that hold its warehouse still. */
export const OPEN_COUNT_STATUSES = ['OPEN', 'SUBMITTED'] as const;

export const WAREHOUSE_COUNTING_AR =
  'في جرد مفتوح على هالمخزن. ما بيدخل عليه ولا بيطلع منه شي بالإيد (التسليم بيمشي) لحد ما ينعتمد الجرد أو ينلغى.';

/** Which of these warehouses has an open count sheet (OPEN or SUBMITTED). One read, none for an empty list. */
export async function warehousesUnderCount(client: Reader, warehouseIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(warehouseIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = await client.stockCount.findMany({
    where: { warehouseId: { in: ids }, status: { in: [...OPEN_COUNT_STATUSES] } },
    select: { warehouseId: true },
  });
  return new Set(rows.map((r) => r.warehouseId));
}

/** Is this one warehouse under count? */
export async function warehouseUnderCount(client: Reader, warehouseId: string): Promise<boolean> {
  return (await warehousesUnderCount(client, [warehouseId])).has(warehouseId);
}

/**
 * The warehouse rows FOR SHARE, in id order — for a door that did not already read them so (a transfer's receipt or
 * cancel, an exit's approval). The comment in the statement names it: the stock documents' frozen comparison with main
 * (`stock-documents-without-combinations-answer-as-main.test.ts`) knows this one lock line as the freeze's own.
 */
export async function holdWarehousesStill(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, warehouseIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(warehouseIds.filter(Boolean))].sort()) {
    await tx.$executeRaw`SELECT 1 FROM "warehouses" WHERE "id" = ${id} FOR SHARE /* count-freeze */`;
  }
}
