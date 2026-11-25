import type { Prisma } from '@prisma/client';
import { db } from './db';
import { lockProductsStock } from './reservation';
import { WAREHOUSE_COUNTING_AR, warehouseUnderCount } from './stock-count-freeze';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * WHERE NEW UNITS LAND — the one question every door that puts units INTO a store asks (the warehouse plan, W2a).
 *
 * Two doors create units today: «استلام بضاعة جاهزة» (`receiving.receiveStock`, which the recount's surplus and the
 * opening count also go through) and «تشغيلة إنتاج» (`POST /api/production`). Both ask `intakePlace` inside their own
 * transaction, before they write:
 *
 *   - a store that is NOT placed (no `warehouse_placements` row): the answer is «nowhere» — `null` — whatever the caller
 *     sent. The door writes exactly the rows it wrote before the warehouses existed; a warehouse id in the body is not
 *     read, not checked, not stored. (The old door's schema stripped such a field silently; so does this.)
 *   - a PLACED store: the warehouse is REQUIRED, and it must be of the store's company and country, running, and one the
 *     caller reaches (`mayUse` — the door passes `warehouses.reachesWarehouse` for the session). Its id goes on the batch
 *     and on the movement.
 *
 * THE TWO RACES IT CLOSES, both inside the caller's transaction:
 *   1. The placement. It takes every product's stock lock (`lockProductsStock`) before it reads the book and writes its
 *      row. This takes the SAME lock for the product before it asks «placed?» — so a receipt either lands before the
 *      placement reads the book (and is placed by it), or it sees the placement and names a warehouse. Without the lock an
 *      unplaced batch could be born in a store that had just been placed: units with no place that are not with a courier.
 *   2. The stop. `PATCH /api/geo/warehouses/:id` locks the warehouse row FOR UPDATE before it counts what the warehouse
 *      holds; this reads the row FOR SHARE. One of the two waits for the other: a stop that went first is seen here as
 *      «stopped», and a receipt that went first is counted by the stop as units the warehouse holds.
 *
 * NO MONEY. Nothing here reads or writes a wallet, an expense or a profit, and the cost of the units is the caller's
 * business, unchanged.
 */

export type IntakeRefusalCode =
  | 'WAREHOUSE_REQUIRED'
  | 'WAREHOUSE_NOT_FOUND'
  | 'WAREHOUSE_OTHER_COUNTRY'
  | 'WAREHOUSE_STOPPED'
  | 'WAREHOUSE_NOT_REACHED'
  // 21/11 (W5a): a count sheet of the warehouse is open — nothing lands on its shelf until it is approved or voided.
  | 'WAREHOUSE_COUNTING';

export class IntakePlaceRefused extends Error {
  constructor(
    readonly code: IntakeRefusalCode,
    readonly errorAr: string,
    readonly status: number
  ) {
    super(errorAr);
    this.name = 'IntakePlaceRefused';
  }
}

const INTAKE_REFUSALS: Record<IntakeRefusalCode, { status: number; ar: string }> = {
  WAREHOUSE_REQUIRED: { status: 400, ar: 'هالمتجر موزّع على مخازن. اختار المخزن اللي دخلت عليه البضاعة.' },
  WAREHOUSE_NOT_FOUND: { status: 400, ar: 'المخزن مش موجود. حدّث الصفحة واختار من جديد.' },
  WAREHOUSE_OTHER_COUNTRY: { status: 400, ar: 'هالمخزن مش ببلد هالمتجر. البضاعة بتدخل على مخازن بلدها بس.' },
  WAREHOUSE_STOPPED: { status: 409, ar: 'هالمخزن موقوف. شغّله أول، أو دخّل البضاعة على مخزن تاني.' },
  WAREHOUSE_NOT_REACHED: { status: 403, ar: 'ما إلك وصول على هالمخزن. دخّل البضاعة على مخزن من مخازنك.' },
  WAREHOUSE_COUNTING: { status: 409, ar: WAREHOUSE_COUNTING_AR },
};

const refused = (code: IntakeRefusalCode) => new IntakePlaceRefused(code, INTAKE_REFUSALS[code].ar, INTAKE_REFUSALS[code].status);

/** The JSON a door answers with: an Arabic sentence and a stable code. */
export function intakeRefusalBody(e: IntakePlaceRefused) {
  return { error: e.errorAr, errorAr: e.errorAr, code: e.code };
}

/**
 * Is this store's stock placed in warehouses? Yes once its opening placement row exists (`warehouse_placements`, one per
 * store, written by `warehouse-placement.placeStore` in the same transaction that gives its batches their places) — and
 * never before. Every stock door asks this before it asks for a warehouse; «no» means the door behaves exactly as it
 * always has. Pass the transaction to ask inside one. (`warehouses.ts` re-exports it.)
 */
export async function storeIsPlaced(storeId: string, client: Pick<typeof db, 'warehousePlacement'> = db): Promise<boolean> {
  const row = await client.warehousePlacement.findUnique({ where: { storeId }, select: { id: true } });
  return row !== null;
}

export type WarehouseRef = { id: string; companyId: string; countryId: string };

/** Reads the warehouse row FOR SHARE: a stop waits for this transaction, and this one waits for a stop already under way. */
async function lockedWarehouse(tx: Tx, warehouseId: string) {
  const rows = await tx.$queryRaw<{ id: string; companyId: string; countryId: string; isActive: boolean }[]>`
    SELECT "id", "companyId", "countryId", "isActive" FROM "warehouses" WHERE "id" = ${warehouseId} FOR SHARE`;
  return rows[0] ?? null;
}

/**
 * Where the units of this intake land: `null` for a store that is not placed (and for a write with no store at all),
 * otherwise the checked warehouse id. Throws `IntakePlaceRefused` for a placed store without a usable warehouse.
 * Must run inside the transaction that writes the batch.
 */
export async function intakePlace(
  tx: Tx,
  input: {
    companyId: string;
    storeId: string | null | undefined;
    productId: string;
    warehouseId?: string | null;
    /** Does the caller reach this warehouse? Asked only for a placed store. Absent = no session to ask about (a lib caller). */
    mayUse?: (warehouse: WarehouseRef) => Promise<boolean>;
  }
): Promise<string | null> {
  if (!input.storeId) return null;
  await lockProductsStock(tx, input.companyId, [input.productId]);
  if (!(await storeIsPlaced(input.storeId, tx))) return null;
  return checkedWarehouse(tx, { companyId: input.companyId, storeId: input.storeId, warehouseId: input.warehouseId, mayUse: input.mayUse });
}

/**
 * The checks a PLACED store's warehouse must pass, in this order: named · of the company · of the store's country ·
 * running · reached by the person. One rule for the receipt, the production run, the return desk and the quick count.
 */
async function checkedWarehouse(
  tx: Tx,
  input: { companyId: string; storeId: string; warehouseId?: string | null; mayUse?: (warehouse: WarehouseRef) => Promise<boolean> }
): Promise<string> {
  const warehouseId = typeof input.warehouseId === 'string' ? input.warehouseId.trim() : '';
  if (!warehouseId) throw refused('WAREHOUSE_REQUIRED');

  const warehouse = await lockedWarehouse(tx, warehouseId);
  if (!warehouse || warehouse.companyId !== input.companyId) throw refused('WAREHOUSE_NOT_FOUND');
  const store = await tx.store.findFirst({ where: { id: input.storeId, companyId: input.companyId }, select: { countryId: true } });
  if (!store || store.countryId !== warehouse.countryId) throw refused('WAREHOUSE_OTHER_COUNTRY');
  if (!warehouse.isActive) throw refused('WAREHOUSE_STOPPED');
  // 21/11 (W5a): read after the row FOR SHARE — a sheet opened before this receipt is seen; one opened after waits for it.
  if (await warehouseUnderCount(tx, warehouse.id)) throw refused('WAREHOUSE_COUNTING');
  if (input.mayUse && !(await input.mayUse({ id: warehouse.id, companyId: warehouse.companyId, countryId: warehouse.countryId }))) {
    throw refused('WAREHOUSE_NOT_REACHED');
  }
  return warehouse.id;
}

/**
 * WHERE A RETURNED PARCEL IS RECEIVED (the warehouse plan, W2b) — the returns desk's own question, asked inside the
 * receipt's transaction. The same answer as `intakePlace`, for every product of the parcel at once: the products' stock
 * locks first (sorted — `lockProductsStock`), then «placed?», then the warehouse's checks. `null` for a store that is not
 * placed: the receipt is then written exactly as it always was.
 *
 * The caller decides what was ASKED: the warehouse the desk named, or — the single door only — the order's own source
 * warehouse when the desk named none («default: the order's source»). «استلام الكل» never defaults: one warehouse for
 * the whole press.
 */
export async function returnPlace(
  tx: Tx,
  input: {
    companyId: string;
    storeId: string | null | undefined;
    productIds: readonly string[];
    warehouseId?: string | null;
    mayUse?: (warehouse: WarehouseRef) => Promise<boolean>;
  }
): Promise<string | null> {
  if (!input.storeId) return null;
  if (input.productIds.length > 0) await lockProductsStock(tx, input.companyId, input.productIds);
  if (!(await storeIsPlaced(input.storeId, tx))) return null;
  return checkedWarehouse(tx, { companyId: input.companyId, storeId: input.storeId, warehouseId: input.warehouseId, mayUse: input.mayUse });
}

/** Is this a refusal of the returns desk's warehouse (an `IntakePlaceRefused` code)? */
export const INTAKE_REFUSAL_CODES: readonly IntakeRefusalCode[] = [
  'WAREHOUSE_REQUIRED',
  'WAREHOUSE_NOT_FOUND',
  'WAREHOUSE_OTHER_COUNTRY',
  'WAREHOUSE_STOPPED',
  'WAREHOUSE_NOT_REACHED',
  'WAREHOUSE_COUNTING',
];

/** The stop door's half of race 2: the warehouse row, locked FOR UPDATE before anything it holds is counted. */
export async function lockWarehouseForStop(tx: Tx, warehouseId: string): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "warehouses" WHERE "id" = ${warehouseId} FOR UPDATE`;
}
