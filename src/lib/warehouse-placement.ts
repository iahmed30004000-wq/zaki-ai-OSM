import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import { splitBatch } from './batch-split';
import { holdingWhere, lockProductsStock } from './reservation';
import { leftWarehouseWhere } from './order-state';
import {
  VARIANT_LINE_AR,
  VARIANT_LINE_STATUS,
  checkLineShapes,
  checkPlacementVariants,
  placeVariants,
  variantCountsField,
  type Fail,
  type VariantLineRefusalCode,
  type VariantQty,
} from './variant-lines';

type Tx = Prisma.TransactionClient | typeof prismaDb;

/**
 * THE OPENING PLACEMENT — once per store, its book stock is put in warehouses (the warehouse plan, request W1a).
 *
 * Until it happens a store has no places: every batch has `warehouseId` NULL and every door behaves as it always did.
 * The placement is the one moment the book is divided between the warehouses the keepers counted, and it divides the
 * book — it never changes it. It writes NO movement, NO adjustment and NO money: units do not enter or leave, they get an
 * address. A count that disagrees with the book is not settled here; it is refused, and the existing recount door
 * («جرد المتاح») is the only place a difference is written.
 *
 * WHAT IS PLACED, per product:
 *   on hand        Σ quantityRemaining of the product's batches — the balances screen's «على الرف», the same rows
 *   with courier   Σ units still reserved by orders of this store that have LEFT the warehouse — the reservation's own
 *                  «still holding» rule (`reservation.holdingWhere`: not refused, not delivered, not cancelled, units
 *                  still held) AND the stock line of the order states (`order-state.leftWarehouseWhere`: shipped, or the
 *                  waybill printed, or on the pickup shelf). Those parcels are in a van or packed under an order's name:
 *                  nobody counts them on a shelf, and they stay unplaced until they are delivered or come back.
 *   to place       on hand − with courier. The counts of the product, summed over the warehouses, must equal it EXACTLY.
 *
 * HOW IT IS DIVIDED — deterministic, so the preview and the press do the same thing:
 *   warehouses in the order given; the product's batches oldest first (production date, then creation time, then id —
 *   the draw-down's own order); each warehouse takes its count from the oldest units not yet taken. A batch that goes
 *   whole to one warehouse is given that warehouse (no twin). A batch shared is split (`batch-split.splitBatch`): when
 *   all of it is placed it keeps the first warehouse and the others get twins; when part of it stays unplaced (the
 *   units with the courier are the newest), it keeps that part with no warehouse and every placed part is a twin.
 *   A batch holding nothing or less than nothing is not touched: it stays unplaced and nets against the courier units.
 * After it: Σ remaining of the unplaced rows of each product = its units with the courier, and every other unit has a place.
 */

export class PlacementRefused extends Error {
  constructor(
    readonly code:
      | 'STORE_NOT_FOUND'
      | 'ALREADY_PLACED'
      | 'NO_WAREHOUSE'
      | 'WAREHOUSE_TWICE'
      | 'WAREHOUSE_NOT_FOUND'
      | 'WAREHOUSE_STOPPED'
      | 'WAREHOUSE_OTHER_COUNTRY'
      | 'PRODUCT_NOT_IN_STORE'
      | 'PRODUCT_TWICE'
      | 'QUANTITY_INVALID'
      | 'NO_COUNTER'
      | 'COUNT_IN_FUTURE'
      | 'ALREADY_HAS_PLACES'
      | 'NOT_EXACT'
      | VariantLineRefusalCode,
    readonly errorAr: string,
    readonly differing?: PlacementRow[]
  ) {
    super(errorAr);
    this.name = 'PlacementRefused';
  }
}

/** How a door answers each refusal: a second placement and a disagreeing count are conflicts; the rest are bad input. */
export function refusalStatus(code: PlacementRefused['code']): number {
  // 20/11 (W8b): a refusal about the combinations answers with its own status.
  if (Object.hasOwn(VARIANT_LINE_STATUS, code)) return VARIANT_LINE_STATUS[code as VariantLineRefusalCode];
  if (code === 'ALREADY_PLACED' || code === 'NOT_EXACT' || code === 'ALREADY_HAS_PLACES') return 409;
  if (code === 'STORE_NOT_FOUND' || code === 'WAREHOUSE_NOT_FOUND') return 404;
  return 400;
}

/** How `variant-lines.ts` refuses inside the placement: as the placement refuses. */
const fail: Fail = (code, errorAr) => {
  throw new PlacementRefused(code, errorAr ?? VARIANT_LINE_AR[code]);
};

/** The counts as a door receives them: per warehouse, in the order the warehouses were given, the units of each product. */
export const countsSchema = z
  .array(
    z.object({
      warehouseId: z.string().min(1).max(64),
      lines: z
        .array(
          z.object({
            productId: z.string().min(1).max(64),
            quantity: z.number().int('العدد لازم يكون رقم صحيح').min(0).max(10_000_000),
            /** 20/11 (W8b): optional — which combinations of the product this warehouse holds; their sum is `quantity`. */
            variants: variantCountsField.optional(),
          })
        )
        .max(5000),
    })
  )
  .max(50);

/** The one sentence a count that disagrees with the book gets: the recount door first, then the placement. */
export const RECOUNT_FIRST_AR = 'اجرد هالمنتجات من «جرد المتاح» أول، وبعدين وزّع';

/**
 * A product with combinations (size/colour): the sheet asks, beside its count per warehouse, how many of each combination
 * that warehouse holds (W8b's optional `variants` of a line). 20/11 (W8c) — was «المنتج بيتوزّع ككل. عدّ الخيارات (المقاس
 * واللون) بيضل على مستوى المتجر لهلق.», true until W8b let the placement carry combinations; now a combination counted here
 * gets its warehouse, and one left blank stays «بلا مكان» (W8a) until it is counted in its warehouse.
 */
export const VARIANTS_IN_PLACEMENT_AR =
  'المنتج اللي إله خيارات (مقاس/لون): اكتب عدده بكل مخزن، وتحته كم قطعة من كل خيار. مجموع الخيارات لازم يساوي عدد المنتج. الخيار اللي بتتركه فاضي بيضل «بلا مكان» لحد ما ينعدّ بمخزنه.';

/** One combination as the sheet draws it: its label and its store-level count (`ProductVariant.onHand`), the server's. */
export interface PlacementCombination {
  variantId: string;
  label: string;
  onHand: number;
}

/**
 * 20/11 (W8c): the ACTIVE combinations of the products that have them, by product, in the seller's order — what the
 * sheet draws its boxes from. ONE read, and none at all when no product of the page has combinations.
 */
export async function placementCombinations(
  tx: Tx,
  companyId: string,
  productIds: readonly string[]
): Promise<Record<string, PlacementCombination[]>> {
  const out: Record<string, PlacementCombination[]> = {};
  if (productIds.length === 0) return out;
  const rows = await tx.productVariant.findMany({
    where: { companyId, productId: { in: [...new Set(productIds)] }, status: 'ACTIVE' },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: { id: true, productId: true, label: true, onHand: true },
  });
  for (const r of rows) (out[r.productId] ??= []).push({ variantId: r.id, label: r.label, onHand: r.onHand });
  return out;
}

export interface PlacementCount {
  warehouseId: string;
  lines: { productId: string; quantity: number; variants?: VariantQty[] }[];
}

export interface FactBatch {
  id: string;
  productId: string;
  batchNumber: string;
  quantityRemaining: number;
  productionDate: Date;
  createdAt: Date;
  warehouseId: string | null;
  inTransitTransferId: string | null;
}

export interface PlacementFacts {
  products: { id: string; name: string; sku: string | null; hasVariants: boolean }[];
  batches: FactBatch[];
  /** Units with the courier, per product (absent = 0). */
  withCourier: Map<string, number>;
}

export interface PlacementRow {
  productId: string;
  name: string;
  sku: string | null;
  onHand: number;
  withCourier: number;
  toPlace: number;
  counted: number;
  /** counted − toPlace: zero is the only answer the press accepts. */
  difference: number;
  perWarehouse: Record<string, number>;
  hasVariants: boolean;
}

export interface BatchStep {
  batchId: string;
  batchNumber: string;
  productId: string;
  /** What the batch row itself keeps: its warehouse (null = stays unplaced) and how many units stay in it. */
  keep: { warehouseId: string | null; quantity: number };
  /** The twins split off it, in order. */
  twins: { warehouseId: string; quantity: number }[];
}

export interface PlacementPlan {
  rows: PlacementRow[];
  differing: PlacementRow[];
  exact: boolean;
  /** Only when exact: what the press will do to each batch. */
  steps: BatchStep[];
  /** Units per warehouse, over every product. */
  totals: Record<string, number>;
}

const byAge = (a: FactBatch, b: FactBatch) =>
  a.productionDate.getTime() - b.productionDate.getTime() ||
  a.createdAt.getTime() - b.createdAt.getTime() ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * THE PLAN — pure. Facts and counts in, the table and the batch steps out; no database, so the preview, the press and the
 * tests all ask the one function. Counts are assumed validated (`checkCounts`): known products, warehouses once each.
 */
export function planPlacement(facts: PlacementFacts, counts: readonly PlacementCount[]): PlacementPlan {
  const order = counts.map((c) => c.warehouseId);
  const countOf = new Map<string, Map<string, number>>();
  for (const c of counts) {
    for (const l of c.lines) {
      const m = countOf.get(l.productId) ?? new Map<string, number>();
      m.set(c.warehouseId, (m.get(c.warehouseId) ?? 0) + l.quantity);
      countOf.set(l.productId, m);
    }
  }
  const batchesOf = new Map<string, FactBatch[]>();
  for (const b of facts.batches) {
    const list = batchesOf.get(b.productId) ?? [];
    list.push(b);
    batchesOf.set(b.productId, list);
  }

  const rows: PlacementRow[] = [];
  const steps: BatchStep[] = [];
  const totals: Record<string, number> = Object.fromEntries(order.map((w) => [w, 0]));

  for (const p of facts.products) {
    const batches = batchesOf.get(p.id) ?? [];
    const onHand = batches.reduce((s, b) => s + b.quantityRemaining, 0);
    const withCourier = facts.withCourier.get(p.id) ?? 0;
    const toPlace = onHand - withCourier;
    const mine = countOf.get(p.id) ?? new Map<string, number>();
    const perWarehouse: Record<string, number> = Object.fromEntries(order.map((w) => [w, mine.get(w) ?? 0]));
    const counted = order.reduce((s, w) => s + perWarehouse[w], 0);
    rows.push({ productId: p.id, name: p.name, sku: p.sku, onHand, withCourier, toPlace, counted, difference: counted - toPlace, perWarehouse, hasVariants: p.hasVariants });
    for (const w of order) totals[w] += perWarehouse[w];
  }

  const differing = rows.filter((r) => r.difference !== 0);
  const exact = differing.length === 0;
  if (!exact) return { rows, differing, exact, steps: [], totals };

  for (const row of rows) {
    const positive = (batchesOf.get(row.productId) ?? []).filter((b) => b.quantityRemaining > 0).sort(byAge);
    const chunks = new Map<string, { warehouseId: string; quantity: number }[]>();
    let i = 0;
    let usedInCurrent = 0;
    for (const w of order) {
      let need = row.perWarehouse[w];
      while (need > 0 && i < positive.length) {
        const b = positive[i];
        const take = Math.min(need, b.quantityRemaining - usedInCurrent);
        const list = chunks.get(b.id) ?? [];
        list.push({ warehouseId: w, quantity: take });
        chunks.set(b.id, list);
        need -= take;
        usedInCurrent += take;
        if (usedInCurrent === b.quantityRemaining) {
          i += 1;
          usedInCurrent = 0;
        }
      }
    }
    for (const b of positive) {
      const list = chunks.get(b.id);
      if (!list) continue; // nothing of it was counted on a shelf: it stays where the courier's units stay
      const placed = list.reduce((s, c) => s + c.quantity, 0);
      const left = b.quantityRemaining - placed;
      steps.push(
        left === 0
          ? { batchId: b.id, batchNumber: b.batchNumber, productId: b.productId, keep: { warehouseId: list[0].warehouseId, quantity: list[0].quantity }, twins: list.slice(1) }
          : { batchId: b.id, batchNumber: b.batchNumber, productId: b.productId, keep: { warehouseId: null, quantity: left }, twins: list }
      );
    }
  }
  return { rows, differing, exact, steps, totals };
}

/** The refusal of a count that disagrees with the book — the products, what the book says there is to place, what was counted. */
export function notExactAr(differing: readonly PlacementRow[]): string {
  const shown = differing.slice(0, 5).map((r) => `«${r.name}» (لازم ${r.toPlace}، انعدّ ${r.counted})`);
  const more = differing.length > 5 ? ` و${differing.length - 5} غيرهم` : '';
  return `العدّ مش مطابق للدفتر: ${shown.join('، ')}${more}. ${RECOUNT_FIRST_AR}.`;
}

/** Units with the courier per product — the two order-state rules named above, one grouped read each for lines and add-ons. */
export async function unitsWithCourier(
  tx: Tx,
  p: { companyId: string; storeId: string; productIds: string[] }
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (p.productIds.length === 0) return out;
  const where = withCourierWhere(p);
  const [lines, addOns] = await Promise.all([
    tx.orderItem.groupBy({ by: ['productId'], where, _sum: { reservedQty: true } }),
    tx.orderAddOn.groupBy({ by: ['productId'], where, _sum: { reservedQty: true } }),
  ]);
  for (const r of [...lines, ...addOns]) out.set(r.productId, (out.get(r.productId) ?? 0) + (r._sum?.reservedQty ?? 0));
  return out;
}

/** «Still held» (the reservation's rule) AND «has left» (the stock line of the order states), as one `where`. */
export function withCourierWhere(p: { companyId: string; storeId: string; productIds: string[] }) {
  const held = holdingWhere({ companyId: p.companyId, productId: { in: [...new Set(p.productIds)] }, storeId: p.storeId });
  return { ...held, order: { ...held.order, ...leftWarehouseWhere() } };
}

/** Everything the plan needs, read the way the balances screen reads it: the store's products, all their batches. */
export async function readPlacementFacts(tx: Tx, companyId: string, storeId: string): Promise<PlacementFacts> {
  const products = await tx.product.findMany({
    where: { companyId, storeId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, sku: true },
  });
  const ids = products.map((p) => p.id);
  if (ids.length === 0) return { products: [], batches: [], withCourier: new Map() };
  const [batches, variants, withCourier] = await Promise.all([
    tx.productionBatch.findMany({
      where: { companyId, productId: { in: ids } },
      select: {
        id: true,
        productId: true,
        batchNumber: true,
        quantityRemaining: true,
        productionDate: true,
        createdAt: true,
        warehouseId: true,
        inTransitTransferId: true,
      },
    }),
    tx.productVariant.findMany({ where: { companyId, productId: { in: ids }, status: 'ACTIVE' }, select: { productId: true } }),
    unitsWithCourier(tx, { companyId, storeId, productIds: ids }),
  ]);
  const withOptions = new Set(variants.map((v) => v.productId));
  return {
    products: products.map((p) => ({ ...p, hasVariants: withOptions.has(p.id) })),
    batches,
    withCourier,
  };
}

export interface PlacementWarehouse {
  id: string;
  companyId: string;
  countryId: string;
  isActive: boolean;
}

/**
 * The checks every caller makes before planning: the store, the warehouses (of its company and country, running, each
 * once), the products (this store's, each once per warehouse), the quantities. Whether the PERSON reaches each warehouse is
 * the door's question (it has the session); this one is about the facts.
 */
export function checkCounts(
  store: { id: string; countryId: string },
  warehouses: readonly PlacementWarehouse[],
  productIds: ReadonlySet<string>,
  counts: readonly PlacementCount[]
) {
  if (counts.length === 0) {
    throw new PlacementRefused('NO_WAREHOUSE', 'اختار مخزن واحد على الأقل. التوزيع بدّو مكان يحط فيه البضاعة.');
  }
  const byId = new Map(warehouses.map((w) => [w.id, w]));
  const seenW = new Set<string>();
  for (const c of counts) {
    if (seenW.has(c.warehouseId)) throw new PlacementRefused('WAREHOUSE_TWICE', 'نفس المخزن مذكور مرتين. اجمع عدّه بعمود واحد.');
    seenW.add(c.warehouseId);
    const w = byId.get(c.warehouseId);
    if (!w) throw new PlacementRefused('WAREHOUSE_NOT_FOUND', 'المخزن مش موجود. حدّث الصفحة.');
    if (w.countryId !== store.countryId) throw new PlacementRefused('WAREHOUSE_OTHER_COUNTRY', 'هالمخزن مش ببلد هالمتجر. البضاعة بتتوزّع على مخازن بلدها بس.');
    if (!w.isActive) throw new PlacementRefused('WAREHOUSE_STOPPED', 'هالمخزن موقوف. شغّله أول أو وزّع على غيره.');
    const seenP = new Set<string>();
    for (const l of c.lines) {
      if (!productIds.has(l.productId)) throw new PlacementRefused('PRODUCT_NOT_IN_STORE', 'في منتج مش من منتجات هالمتجر. حدّث الصفحة.');
      if (seenP.has(l.productId)) throw new PlacementRefused('PRODUCT_TWICE', 'نفس المنتج مذكور مرتين بنفس المخزن.');
      seenP.add(l.productId);
      if (!Number.isInteger(l.quantity) || l.quantity < 0) throw new PlacementRefused('QUANTITY_INVALID', 'العدد لازم يكون رقم صحيح من صفر وطالع.');
    }
    // 20/11 (W8b): a line that names combinations names each once, and they sum to its quantity.
    checkLineShapes(c.lines, fail);
  }
}

async function loadStoreAndWarehouses(tx: Tx, companyId: string, storeId: string, counts: readonly PlacementCount[]) {
  const store = await tx.store.findFirst({ where: { id: storeId, companyId }, select: { id: true, countryId: true } });
  if (!store) throw new PlacementRefused('STORE_NOT_FOUND', 'المتجر مش موجود. اختار المتجر من فوق.');
  const warehouses = await tx.warehouse.findMany({
    where: { companyId, id: { in: [...new Set(counts.map((c) => c.warehouseId))] } },
    select: { id: true, companyId: true, countryId: true, isActive: true },
  });
  return { store, warehouses };
}

async function alreadyPlaced(tx: Tx, storeId: string) {
  return tx.warehousePlacement.findUnique({ where: { storeId }, select: { countedByName: true, countedAt: true } });
}

function placedAr(p: { countedByName: string; countedAt: Date }) {
  return `هالمتجر انوزّع على المخازن من قبل (عدّه ${p.countedByName} بتاريخ ${p.countedAt.toISOString().slice(0, 10)}). التوزيع بيصير مرة وحدة.`;
}

/** THE PREVIEW: the same checks and the same plan, nothing written. Counts may be empty (the table before anyone typed). */
export async function previewPlacement(tx: Tx, input: { companyId: string; storeId: string; counts: readonly PlacementCount[] }) {
  const placed = await alreadyPlaced(tx, input.storeId);
  if (placed) throw new PlacementRefused('ALREADY_PLACED', placedAr(placed));
  const facts = await readPlacementFacts(tx, input.companyId, input.storeId);
  if (input.counts.length > 0) {
    const { store, warehouses } = await loadStoreAndWarehouses(tx, input.companyId, input.storeId, input.counts);
    checkCounts(store, warehouses, new Set(facts.products.map((p) => p.id)), input.counts);
    // 20/11 (W8b): the same combination checks as the press (nothing read when no line names one).
    await checkPlacementVariants(tx, { companyId: input.companyId, counts: input.counts, nameOf: new Map(facts.products.map((p) => [p.id, p.name])) }, fail);
  }
  return planPlacement(facts, input.counts);
}

/**
 * THE PRESS — inside ONE transaction. Locks every product of the store (the reserver's lock), then refuses a second
 * placement, a count that disagrees, or a batch that somehow already has a place; then writes the placement row and
 * carries out the plan, batch by batch.
 */
export async function placeStore(
  tx: Tx,
  input: {
    companyId: string;
    storeId: string;
    countedByName: string;
    countedAt: Date;
    note?: string | null;
    recordedById: string;
    counts: readonly PlacementCount[];
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const countedByName = input.countedByName.trim();
  if (countedByName.length < 3) throw new PlacementRefused('NO_COUNTER', 'اكتب اسم اللي عدّ. التوزيع بلا اسم مش عدّ موقّع.');
  if (input.countedAt.getTime() > now.getTime() + 60_000) throw new PlacementRefused('COUNT_IN_FUTURE', 'وقت العدّ بالمستقبل. صحّحه.');

  const { store, warehouses } = await loadStoreAndWarehouses(tx, input.companyId, input.storeId, input.counts);
  const ids = (await tx.product.findMany({ where: { companyId: input.companyId, storeId: input.storeId }, select: { id: true } })).map((p) => p.id);
  checkCounts(store, warehouses, new Set(ids), input.counts);

  // Every product's lock before anything is read: the book this plan divides is the book nobody else is changing.
  await lockProductsStock(tx, input.companyId, ids);

  const placed = await alreadyPlaced(tx, input.storeId);
  if (placed) throw new PlacementRefused('ALREADY_PLACED', placedAr(placed));

  const facts = await readPlacementFacts(tx, input.companyId, input.storeId);
  if (facts.batches.some((b) => b.warehouseId !== null || b.inTransitTransferId !== null)) {
    throw new PlacementRefused('ALREADY_HAS_PLACES', 'في دفعات لهالمتجر إلها مكان من قبل. التوزيع الافتتاحي بيصير على متجر ما انوزّع.');
  }
  const plan = planPlacement(facts, input.counts);
  if (!plan.exact) throw new PlacementRefused('NOT_EXACT', notExactAr(plan.differing), plan.differing);
  await checkPlacementVariants(tx, { companyId: input.companyId, counts: input.counts, nameOf: new Map(facts.products.map((p) => [p.id, p.name])) }, fail);

  const placement = await tx.warehousePlacement.create({
    data: {
      companyId: input.companyId,
      storeId: input.storeId,
      countedByName,
      countedAt: input.countedAt,
      note: input.note?.trim() || null,
      recordedById: input.recordedById,
    },
  });

  for (const step of plan.steps) {
    for (const twin of step.twins) {
      await splitBatch(tx, { companyId: input.companyId, batchId: step.batchId, quantity: twin.quantity, to: { warehouseId: twin.warehouseId } });
    }
    if (step.keep.warehouseId) {
      const kept = await tx.productionBatch.updateMany({
        where: { id: step.batchId, companyId: input.companyId, warehouseId: null, inTransitTransferId: null, quantityRemaining: step.keep.quantity },
        data: { warehouseId: step.keep.warehouseId },
      });
      if (kept.count !== 1) {
        throw new PlacementRefused('ALREADY_HAS_PLACES', `الدفعة ${step.batchNumber} تغيّرت وقت التوزيع. جرّب كمان مرة.`);
      }
    }
  }
  // 20/11 (W8b): the combinations counted in each warehouse leave «بلا مكان» for it — after the batch rows, through the
  // one writer of a combination's count. Combinations not named stay «بلا مكان» (W8a) until a keeper counts them.
  await placeVariants(
    tx,
    { companyId: input.companyId, storeId: input.storeId, userId: input.recordedById, referenceId: placement.id },
    { counts: input.counts, reason: `التوزيع الافتتاحي — عدّه ${countedByName}` },
    fail
  );
  return { placement, plan };
}
