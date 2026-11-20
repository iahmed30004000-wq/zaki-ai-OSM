import type { Prisma } from '@prisma/client';
import type { db } from './db';
import type { WarehouseRef } from './warehouse-intake';

/*
 * `warehouse-intake` is loaded WHEN ASKED, not at the top: `product-variants.ts` imports this file, and half the order and
 * stock libraries import `product-variants.ts` — a value import of the intake module (which loads `./db`) would change the
 * order in which every one of them loads its database. One rule, still one home (`storeIsPlaced`, `intakePlace`).
 */
const intake = () => import('./warehouse-intake');

type Tx = Prisma.TransactionClient | typeof db;

/**
 * A COMBINATION'S COUNT PER WAREHOUSE — the warehouse plan, request W8a.
 *
 * A product with options (size, colour) keeps one count per combination: `ProductVariant.onHand`. Before this request
 * that count was a single store-level number, overwritten by the variants screen with no trace. For a store that is NOT
 * placed in warehouses (`storeIsPlaced` false) nothing here runs: every caller keeps the code it had, line for line.
 *
 * For a PLACED store:
 *
 *   WHERE THE PIECES ARE   one `product_variant_stock` row per (combination, warehouse), plus ONE row with no warehouse:
 *                          «بلا مكان». The opening placement (W1a) divided the product's units between the warehouses but
 *                          not its combinations — so the count a combination has when its store is first touched here is
 *                          not divided by guesswork: it ALL becomes «بلا مكان» (an OPENING ledger line says so), and a
 *                          keeper counts it into the warehouses. No piece is invented and none is lost.
 *   THE TOTAL              `ProductVariant.onHand` = Σ of those rows, ALWAYS. It is written by ONE function,
 *                          `writePlaces` below, which moves the rows, writes the ledger and then writes the total as the
 *                          sum it reads back. Nothing else writes `onHand` for a placed store.
 *   THE LEDGER             one `variant_stock_movements` line per row a change moved. Σ of a combination's lines = its
 *                          `onHand` (the OPENING line carries what it had before).
 *
 * THE THREE CHANGES:
 *
 *   COUNT (the variants screen, a named warehouse, a reason)
 *       The keeper says «this warehouse holds N». Going up, the extra pieces are first taken from «بلا مكان» — they were
 *       on the books all along and only lacked a place — and only what is beyond «بلا مكان» is a real surplus that raises
 *       the total. Going down is a real shortage: the total falls. So counting a combination's pieces into its warehouses
 *       for the first time leaves the total exactly where it was.
 *   SALE (a delivery — every delivery door goes through `stock-consumption.consumeOrderStock`)
 *       The pieces leave, in this order: the order's own warehouse (`Order.sourceWarehouseId`, stamped by W4a when it is
 *       built — no order carries one today), then «بلا مكان» (where the pieces with the courier stayed at the placement),
 *       then the store's other warehouses, the fullest first (ties by id). A place never goes below zero, and what no
 *       place holds is not taken — the total stops at zero, exactly as the store-level count always did.
 *   RETURN (a counted return)
 *       The pieces come back to the warehouse the returns desk names (W2b passes it when it is built); with none named,
 *       to «بلا مكان» — where the product's own return batch lands today (its `RET-` batch has no warehouse until W2b).
 *
 * LOCKS. Every change takes the combination rows FOR UPDATE (sorted by id) before it reads its places, so two changes of
 * one combination run one after the other and the total is always the sum. It does not take the product's stock lock:
 * a delivery has already written batch rows when it gets here, and the stock lock is taken BEFORE batch rows by the split
 * and the placement — taking it here would let the two wait for each other. The count door takes the stock lock first
 * (through `intakePlace`), before any row — the same order as the split.
 *
 * NO MONEY. No price, no cost, no wallet, no expense, no profit is read or written here; the product's batches stay the
 * ledger of its total and of its cost.
 */

export const VARIANT_MOVE = {
  OPENING: 'OPENING',
  COUNT: 'COUNT',
  SALE: 'SALE',
  RETURN: 'RETURN',
} as const;
export type VariantMoveType = (typeof VARIANT_MOVE)[keyof typeof VARIANT_MOVE];

/** The OPENING line's reason: the count the combination had, before any place was named. */
export const OPENING_REASON_AR = 'عدد الخيار قبل توزيعه على المخازن — بلا مكان لحد ما ينعدّ';

export type VariantCountRefusalCode =
  | 'WAREHOUSE_REQUIRED'
  | 'WAREHOUSE_NOT_FOUND'
  | 'WAREHOUSE_OTHER_COUNTRY'
  | 'WAREHOUSE_STOPPED'
  | 'WAREHOUSE_NOT_REACHED'
  | 'REASON_REQUIRED';

const COUNT_REFUSALS: Record<VariantCountRefusalCode, { status: number; ar: string }> = {
  WAREHOUSE_REQUIRED: { status: 400, ar: 'هالمتجر موزّع على مخازن. عدد كل خيار صار لكل مخزن: اختار المخزن اللي عدّيته واكتب السبب.' },
  WAREHOUSE_NOT_FOUND: { status: 400, ar: 'المخزن مش موجود. حدّث الصفحة واختار من جديد.' },
  WAREHOUSE_OTHER_COUNTRY: { status: 400, ar: 'هالمخزن مش ببلد هالمتجر. بتعدّ بمخازن بلده بس.' },
  WAREHOUSE_STOPPED: { status: 409, ar: 'هالمخزن موقوف. شغّله أول، أو عدّ بمخزن تاني.' },
  WAREHOUSE_NOT_REACHED: { status: 403, ar: 'ما إلك وصول على هالمخزن. عدّ بمخزن من مخازنك.' },
  REASON_REQUIRED: { status: 400, ar: 'اكتب سبب العدّ. تغيير عدد خيار بمخزن بدّو سبب.' },
};

export class VariantCountRefused extends Error {
  readonly errorAr: string;
  readonly status: number;
  constructor(readonly code: VariantCountRefusalCode) {
    super(COUNT_REFUSALS[code].ar);
    this.name = 'VariantCountRefused';
    this.errorAr = COUNT_REFUSALS[code].ar;
    this.status = COUNT_REFUSALS[code].status;
  }
}

/** The JSON a door answers with: an Arabic sentence and a stable code. */
export function countRefusalBody(e: VariantCountRefused) {
  return { error: e.errorAr, errorAr: e.errorAr, code: e.code };
}

/** The reason a count must carry: at least three letters once trimmed. */
export function countReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const r = raw.trim();
  return r.length >= 3 ? r.slice(0, 300) : null;
}

/**
 * THE WAREHOUSE A COUNT IS FOR, checked by the receiving door's own rule (`warehouse-intake.intakePlace`): of the store's
 * company and country, running, reached by the person. It also takes the product's stock lock — before any row, as the
 * split does. Returns `null` for a store that is not placed (the caller then has nothing to do here).
 */
export async function countPlace(
  tx: Tx,
  input: {
    companyId: string;
    storeId: string | null;
    productId: string;
    warehouseId: unknown;
    mayUse?: (warehouse: WarehouseRef) => Promise<boolean>;
  }
): Promise<string | null> {
  const { IntakePlaceRefused, intakePlace } = await intake();
  try {
    return await intakePlace(tx, {
      companyId: input.companyId,
      storeId: input.storeId,
      productId: input.productId,
      warehouseId: typeof input.warehouseId === 'string' ? input.warehouseId : null,
      mayUse: input.mayUse,
    });
  } catch (e) {
    if (e instanceof IntakePlaceRefused) throw new VariantCountRefused(e.code);
    throw e;
  }
}

/** Is this store placed? — the one question that decides between today's code and this file. */
export async function variantsArePlaced(tx: Tx, storeId: string | null | undefined): Promise<boolean> {
  if (!storeId) return false;
  return (await intake()).storeIsPlaced(storeId, tx);
}

interface PlaceRow {
  id: string;
  warehouseId: string | null;
  onHand: number;
}

interface Who {
  companyId: string;
  storeId: string | null;
  userId?: string | null;
  orderId?: string | null;
}

/** The combination rows, FOR UPDATE, in id order: every change of one combination waits for the one before it. */
async function lockVariants(tx: Tx, ids: readonly string[]) {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length === 0) return;
  await tx.$queryRaw`SELECT "id" FROM "product_variants" WHERE "id" = ANY(${sorted}::text[]) ORDER BY "id" FOR UPDATE`;
}

/**
 * The combination's places — and, the first time a placed store's combination is touched, its «بلا مكان» row holding the
 * count it had (with its OPENING line). Must run after `lockVariants`.
 */
async function placesOf(tx: Tx, who: Who, variantId: string): Promise<{ productId: string; places: PlaceRow[] } | null> {
  const variant = await tx.productVariant.findFirst({
    where: { id: variantId, companyId: who.companyId },
    select: { productId: true, onHand: true },
  });
  if (!variant) return null;
  const places = await tx.productVariantStock.findMany({
    where: { variantId },
    orderBy: { id: 'asc' },
    select: { id: true, warehouseId: true, onHand: true },
  });
  if (places.length === 0 && variant.onHand !== 0) {
    const row = await tx.productVariantStock.create({
      data: { companyId: who.companyId, variantId, warehouseId: null, onHand: variant.onHand },
      select: { id: true, warehouseId: true, onHand: true },
    });
    await tx.variantStockMovement.create({
      data: {
        companyId: who.companyId,
        storeId: who.storeId,
        productId: variant.productId,
        variantId,
        warehouseId: null,
        type: VARIANT_MOVE.OPENING,
        quantity: variant.onHand,
        placeAfter: variant.onHand,
        onHandAfter: variant.onHand,
        reason: OPENING_REASON_AR,
        orderId: null,
        createdById: who.userId ?? null,
      },
    });
    places.push(row);
  }
  return { productId: variant.productId, places };
}

/**
 * THE ONE WRITER of a placed store's combination count. Moves each named place by its delta (creating the place's row the
 * first time), writes one ledger line per place moved, then writes `ProductVariant.onHand` as the sum of the places it
 * reads back. Returns that total. A change of nothing writes nothing.
 */
async function writePlaces(
  tx: Tx,
  who: Who,
  p: {
    productId: string;
    variantId: string;
    places: PlaceRow[];
    type: VariantMoveType;
    moves: { warehouseId: string | null; delta: number }[];
    reason: string | null;
  }
): Promise<number | null> {
  const moves = p.moves.filter((m) => m.delta !== 0);
  if (moves.length === 0) return null;
  const lines: { warehouseId: string | null; quantity: number; placeAfter: number }[] = [];
  for (const m of moves) {
    let row = p.places.find((x) => x.warehouseId === m.warehouseId);
    if (!row) {
      row = await tx.productVariantStock.create({
        data: { companyId: who.companyId, variantId: p.variantId, warehouseId: m.warehouseId, onHand: 0 },
        select: { id: true, warehouseId: true, onHand: true },
      });
      p.places.push(row);
    }
    const after = row.onHand + m.delta;
    await tx.productVariantStock.update({ where: { id: row.id }, data: { onHand: after } });
    row.onHand = after;
    lines.push({ warehouseId: m.warehouseId, quantity: m.delta, placeAfter: after });
  }
  const sum = await tx.productVariantStock.aggregate({ where: { variantId: p.variantId }, _sum: { onHand: true } });
  const total = sum._sum?.onHand ?? 0;
  await tx.productVariant.update({ where: { id: p.variantId }, data: { onHand: total } });
  for (const l of lines) {
    await tx.variantStockMovement.create({
      data: {
        companyId: who.companyId,
        storeId: who.storeId,
        productId: p.productId,
        variantId: p.variantId,
        warehouseId: l.warehouseId,
        type: p.type,
        quantity: l.quantity,
        placeAfter: l.placeAfter,
        onHandAfter: total,
        reason: p.reason,
        orderId: who.orderId ?? null,
        createdById: who.userId ?? null,
      },
    });
  }
  return total;
}

/** Which places a delivery empties, and how much of each — pure: the order's warehouse, «بلا مكان», then the fullest. */
export function drawPlan(
  places: readonly { warehouseId: string | null; onHand: number }[],
  quantity: number,
  sourceWarehouseId: string | null
): { warehouseId: string | null; delta: number }[] {
  const rank = (w: string | null) => (sourceWarehouseId && w === sourceWarehouseId ? 0 : w === null ? 1 : 2);
  const order = [...places].sort(
    (a, b) =>
      rank(a.warehouseId) - rank(b.warehouseId) ||
      b.onHand - a.onHand ||
      ((a.warehouseId ?? '') < (b.warehouseId ?? '') ? -1 : (a.warehouseId ?? '') > (b.warehouseId ?? '') ? 1 : 0)
  );
  const out: { warehouseId: string | null; delta: number }[] = [];
  let need = Math.max(0, quantity);
  for (const p of order) {
    if (need <= 0) break;
    const take = Math.min(need, Math.max(0, p.onHand));
    if (take > 0) {
      out.push({ warehouseId: p.warehouseId, delta: -take });
      need -= take;
    }
  }
  return out;
}

/** What a count of one warehouse moves — pure: up takes from «بلا مكان» first, the rest is a surplus; down is a shortage. */
export function countPlan(
  places: readonly { warehouseId: string | null; onHand: number }[],
  warehouseId: string,
  counted: number
): { warehouseId: string | null; delta: number }[] {
  const here = places.find((p) => p.warehouseId === warehouseId)?.onHand ?? 0;
  const d = counted - here;
  if (d <= 0) return d === 0 ? [] : [{ warehouseId, delta: d }];
  const unplaced = Math.max(0, places.find((p) => p.warehouseId === null)?.onHand ?? 0);
  const fromUnplaced = Math.min(d, unplaced);
  return fromUnplaced > 0 ? [{ warehouseId, delta: d }, { warehouseId: null, delta: -fromUnplaced }] : [{ warehouseId, delta: d }];
}

/** A DELIVERY of a placed store: each combination's pieces leave by `drawPlan`. `pieces` may name a combination twice. */
export async function drawPlacedVariants(
  tx: Tx,
  who: Who & { sourceWarehouseId: string | null },
  pieces: readonly { variantId: string; quantity: number }[]
) {
  const need = new Map<string, number>();
  for (const x of pieces) need.set(x.variantId, (need.get(x.variantId) ?? 0) + x.quantity);
  await lockVariants(tx, [...need.keys()]);
  for (const [variantId, quantity] of [...need].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (quantity <= 0) continue;
    const found = await placesOf(tx, who, variantId);
    if (!found) continue;
    await writePlaces(tx, who, {
      productId: found.productId,
      variantId,
      places: found.places,
      type: VARIANT_MOVE.SALE,
      moves: drawPlan(found.places, quantity, who.sourceWarehouseId),
      reason: null,
    });
  }
}

/** A COUNTED RETURN of a placed store: `quantity` pieces back onto the named warehouse, or «بلا مكان» with none. */
export async function restorePlacedVariant(
  tx: Tx,
  who: Who & { warehouseId: string | null },
  p: { variantId: string; quantity: number }
) {
  if (p.quantity <= 0) return;
  await lockVariants(tx, [p.variantId]);
  const found = await placesOf(tx, who, p.variantId);
  if (!found) return;
  await writePlaces(tx, who, {
    productId: found.productId,
    variantId: p.variantId,
    places: found.places,
    type: VARIANT_MOVE.RETURN,
    moves: [{ warehouseId: who.warehouseId, delta: p.quantity }],
    reason: null,
  });
}

/**
 * A KEEPER'S COUNT of one warehouse, for several combinations of one product: `counts` maps a combination to what the
 * warehouse holds of it. Combinations whose count does not change write nothing. Returns how many changed. The caller has
 * checked the warehouse (`countPlace`) and holds the reason.
 */
export async function countPlacedVariants(
  tx: Tx,
  who: Who,
  p: { warehouseId: string; reason: string; counts: ReadonlyMap<string, number> }
): Promise<number> {
  await lockVariants(tx, [...p.counts.keys()]);
  let changed = 0;
  for (const [variantId, counted] of [...p.counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const found = await placesOf(tx, who, variantId);
    if (!found) continue;
    const total = await writePlaces(tx, who, {
      productId: found.productId,
      variantId,
      places: found.places,
      type: VARIANT_MOVE.COUNT,
      moves: countPlan(found.places, p.warehouseId, counted),
      reason: p.reason,
    });
    if (total !== null) changed += 1;
  }
  return changed;
}

/**
 * What one warehouse holds of each of these combinations now — the screen's starting figure for a count, and the door's
 * «did this count change anything?». A combination never touched here holds nothing in any warehouse (all «بلا مكان»).
 */
export async function placesOfVariants(
  client: Tx,
  variants: readonly { id: string; onHand: number }[]
): Promise<Map<string, { warehouseId: string | null; onHand: number }[]>> {
  const out = new Map<string, { warehouseId: string | null; onHand: number }[]>();
  if (variants.length === 0) return out;
  const rows = await client.productVariantStock.findMany({
    where: { variantId: { in: variants.map((v) => v.id) } },
    orderBy: { id: 'asc' },
    select: { variantId: true, warehouseId: true, onHand: true },
  });
  for (const v of variants) {
    const mine = rows.filter((r) => r.variantId === v.id).map((r) => ({ warehouseId: r.warehouseId, onHand: r.onHand }));
    out.set(v.id, mine.length > 0 ? mine : v.onHand !== 0 ? [{ warehouseId: null, onHand: v.onHand }] : []);
  }
  return out;
}
