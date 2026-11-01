import type { Prisma } from '@prisma/client';
import { orderRefFields } from './order-ref';
import { releaseOrderLines, reserveOrderLines } from './reservation';
import { computeCod, roundMinor } from './money';
import { costOfACopy, fixedCostsOf } from './product-fixed-cost';

/**
 * A SECOND ORDER FOR THE SAME SALE.
 *
 * Two moments need one: a parcel taken back from a courier company, and a
 * change to the goods on a parcel they are already holding. Both are the
 * same physical fact — that parcel is out there under their barcode and
 * will appear in their statement, so it cannot be edited into being a
 * different parcel. What ships instead is a NEW order, linked to the old
 * one by `replacesOrderId`, and the old one ends as a return.
 *
 * The transfer route built this first and built it correctly. The reorder
 * needed the same thing, and a second copy of it is where «the lines are
 * carried over» or «the goods come off the shelf now» silently stops being
 * true on one of the two paths. So it is written once, here, and the two
 * callers differ only in where the replacement is going and what the note
 * on it says.
 *
 * WHAT THIS DOES NOT DO is decide. It does not read a seal, check a
 * permission or choose a status; the caller has already done all of that
 * and passes the answers in. This takes an order and returns its
 * replacement, reserved.
 */

/** The columns a replacement is copied from. */
export interface ReplacementSource {
  id: string;
  orderNumber: string;
  countryId: string | null;
  storeId: string | null;
  regionId: string | null;
  customerId: string;
  productId: string;
  offerId: string | null;
  quantity: number;
  freeQuantity: number;
  sellingPrice: number;
  discountAmount: number;
  shippingCost: number;
  totalAmount: number;
  currency: string;
  priceIncludesDelivery: boolean | null;
  productNameSnapshot: string | null;
  productImageSnapshot: string | null;
  moderatorId: string | null;
  estimatedCostOfGoods: number;
  source: string;
  customerNotes: string | null;
  /**
   * WHO SOLD IT AND WHERE IT CAME FROM — all optional, all nullable.
   *
   * Optional because the callers hand over the whole order row and a test
   * hands over a short one; nullable because an order raised in the shop
   * has no campaign and an imported one has no confirmer. A missing value
   * is copied as a missing value, never invented.
   */
  channelId?: string | null;
  campaignId?: string | null;
  landingPageId?: string | null;
  deviceClass?: string | null;
  adId?: string | null;
  adSourceType?: string | null;
  refCode?: string | null;
  refCodeAt?: Date | null;
  touchAt?: Date | null;
  pageId?: string | null;
  wabaId?: string | null;
  conversationRef?: string | null;
  confirmedById?: string | null;
  assignedToId?: string | null;
  assignedAt?: Date | null;
}

/**
 * THE COLUMNS THAT SAY WHO SOLD IT AND WHERE THE CUSTOMER CAME FROM.
 *
 * The replacement is the same sale in a new order, so it keeps the sale's
 * name on it. Without these the campaign that paid for the click, the page
 * the customer ordered from and the person who confirmed it were all left on
 * the old order — which ends as a return — and the order that finally
 * delivers belonged to nobody.
 *
 * ONLY NAMES, NEVER AMOUNTS. Not one of these is a price, a fee, a discount
 * or a commission; the figures are built from the lines below by the one COD
 * function, as before.
 *
 * AND WHAT IS LEFT BEHIND ON PURPOSE:
 *
 *   · `ctwaClidEnc`, `psidEnc` — sealed, and written by the systems door
 *     alone (the-attribution-invariants.test.ts holds that).
 *   · `externalRef` — the OTHER system's name for the old order.
 *   · `createdById` (the OLD one's), `claimedById`, `currentOwnerId` — who
 *     entered it, who holds its confirmation and who handles it now are all
 *     facts about the old order's work; the replacement enters at preparation.
 *     The replacement's OWN creator is the person who pressed the button, and
 *     the caller says so (`ReplacementPlan.createdById`, RV8) — never copied.
 *   · `confirmedAt` — a replacement is created after its own confirmation
 *     time would be, and a confirmation-speed report must not read a
 *     negative.
 *   · `moderatorCommission` — a legacy money column.
 */
export function carriedSale(order: ReplacementSource) {
  return {
    channelId: order.channelId ?? null,
    campaignId: order.campaignId ?? null,
    landingPageId: order.landingPageId ?? null,
    deviceClass: order.deviceClass ?? null,
    adId: order.adId ?? null,
    adSourceType: order.adSourceType ?? null,
    refCode: order.refCode ?? null,
    refCodeAt: order.refCodeAt ?? null,
    touchAt: order.touchAt ?? null,
    pageId: order.pageId ?? null,
    wabaId: order.wabaId ?? null,
    conversationRef: order.conversationRef ?? null,
    moderatorId: order.moderatorId,
    confirmedById: order.confirmedById ?? null,
    assignedToId: order.assignedToId ?? null,
    assignedAt: order.assignedAt ?? null,
  };
}

export interface ReplacementPlan {
  companyId: string;
  order: ReplacementSource;
  /** For the fresh order number; a clash retries the whole transaction. */
  orderPrefix: string;
  attempt: number;
  minorUnit: number;
  allowNegativeStock: boolean;
  /**
   * The staff account that pressed the button — written as the replacement's `createdById` ("the account that ENTERED
   * this order"). Optional only so an old caller keeps compiling; every caller in this repository passes it. Absent
   * writes nothing, as before: the creator of the ORIGINAL is never copied onto the replacement.
   */
  createdById?: string | null;
  /** Where the replacement starts life — the caller's decision, not this one's. */
  shippingStatus: string;
  deliveryProviderId?: string | null;
  shippingBatchId?: string | null;
  internalNotes: string;
  /**
   * WHAT THE REPLACEMENT CARRIES THAT THE ORIGINAL DID NOT.
   *
   * Only the two that can reach here: a change to the goods on a sealed
   * parcel is a change to how many, or to the discount — an address or a
   * phone is fixable on the courier's own waybill and never becomes a
   * reorder, and the product and the offer cannot be applied by the change
   * path at all. A transfer carries none of these and passes nothing.
   */
  overrides?: { quantity?: number; discountAmount?: number };
  /**
   * THE GOODS ARE ANOTHER ORDER'S BOX, AND THE ORDER IS BORN DELIVERED.
   *
   * Only the parcel swap passes this (src/lib/parcel-swap.ts): the courier handed the customer a box that
   * was packed for someone else, and collected for it. The customer, the sale's people and the campaign
   * come from `order` as always; the goods, the price and the dates come from the box and the statement line.
   */
  box?: BoxPlan;
}

/** What the swap tells the replacement: whose box, how many pieces, what was paid, and when. */
export interface BoxPlan {
  /** The order whose box it was — its lines are read here. */
  fromOrderId: string;
  /** How many pieces of that box the customer took. */
  pieces: number;
  /** What the customer paid at the door, fee included — the statement line's gross. */
  paid: number;
  /** The courier's fee for the leg, kept out of what they hand over. */
  fee: number;
  priceIncludesDelivery: boolean;
  shippedAt: Date | null;
  deliveredAt: Date;
}

export interface ReplacementResult {
  id: string;
  orderNumber: string;
  /** The box path only: what the customer paid, as the one COD function priced it. */
  cod?: number;
  /** The box path only: the fee kept out of it. */
  fee?: number;
}

/** A line of a box, as the swap reads it. */
export interface BoxLine {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  freeQuantity: number;
}

/** Every physical piece in the box, gifts included. */
export function boxUnits(lines: ReadonlyArray<Pick<BoxLine, 'quantity' | 'freeQuantity'>>): number {
  return lines.reduce((sum, l) => sum + l.quantity + l.freeQuantity, 0);
}

/**
 * WHICH LINES THE PIECES COME OUT OF — in the order the box was packed.
 *
 * The customer took `pieces` of the box; line by line, as many as the line holds. A gift is a piece like any
 * other here: the customer paid one sum for what they were handed, and what they were handed is what counts.
 */
export function takeFromBox(lines: ReadonlyArray<BoxLine>, pieces: number): { line: BoxLine; qty: number }[] {
  if (!Number.isInteger(pieces) || pieces < 1 || pieces > boxUnits(lines)) {
    throw new Error('BOX_PIECES_OUT_OF_RANGE');
  }
  const out: { line: BoxLine; qty: number }[] = [];
  let left = pieces;
  for (const line of lines) {
    if (left <= 0) break;
    const qty = Math.min(left, line.quantity + line.freeQuantity);
    if (qty <= 0) continue;
    out.push({ line, qty });
    left -= qty;
  }
  return out;
}

export interface PricedBox {
  subtotal: number;
  cod: number;
  fee: number;
  lines: { line: BoxLine; qty: number; unitPrice: number; lineTotal: number }[];
}

/**
 * WHAT THE CUSTOMER PAID, SPREAD OVER WHAT THEY WERE HANDED — through the one COD function.
 *
 * The price is not the box's own price: the customer paid what the courier collected. So the goods are what was
 * paid (less the fee when the fee is on top), shared out by pieces with the last fils on the largest line, and
 * `computeCod` then writes the order's figures — which must come back to exactly what was paid, or nothing is
 * written at all. A swap that cannot reproduce the courier's own figure would be a MISMATCHED line made by us.
 */
export function priceTheBox(p: {
  taken: { line: BoxLine; qty: number }[];
  paid: number;
  fee: number;
  priceIncludesDelivery: boolean;
  minorUnit: number;
}): PricedBox {
  const paid = roundMinor(p.paid, p.minorUnit);
  const fee = roundMinor(Math.max(0, p.fee), p.minorUnit);
  const goods = p.priceIncludesDelivery ? paid : roundMinor(paid - fee, p.minorUnit);
  if (!(goods > 0)) throw new Error('BOX_PRICE_NOT_POSITIVE');

  const units = p.taken.reduce((sum, t) => sum + t.qty, 0);
  const shares = p.taken.map((t) => roundMinor((goods * t.qty) / units, p.minorUnit));
  const drift = roundMinor(goods - shares.reduce((a, b) => a + b, 0), p.minorUnit);
  if (drift !== 0) {
    let largest = 0;
    for (let i = 1; i < shares.length; i++) if (shares[i] > shares[largest]) largest = i;
    shares[largest] = roundMinor(shares[largest] + drift, p.minorUnit);
  }

  const money = computeCod({
    lines: p.taken.map((t, i) => ({ quantity: t.qty, unitPrice: shares[i] / t.qty })),
    discount: 0,
    deliveryFee: fee,
    priceIncludesDelivery: p.priceIncludesDelivery,
    minorUnit: p.minorUnit,
  });
  if (money.cod !== paid) throw new Error('BOX_PRICE_DRIFT');

  return {
    subtotal: money.subtotal,
    cod: money.cod,
    fee: money.deliveryFee,
    lines: p.taken.map((t, i) => ({
      line: t.line,
      qty: t.qty,
      lineTotal: money.lineTotals[i],
      unitPrice: money.lineTotals[i] / t.qty,
    })),
  };
}

/** The write lost its race: the order the box was going into moved on after it was read. */
export class BoxOrderMoved extends Error {
  constructor() {
    super('BOX_ORDER_MOVED');
  }
}

/** Reads the box and prices it — shared by the new order and by the one that is reshaped. */
async function readAndPriceBox(tx: Prisma.TransactionClient, companyId: string, minorUnit: number, box: BoxPlan) {
  const from = await tx.order.findFirst({
    where: { id: box.fromOrderId, companyId },
    select: {
      productId: true,
      productNameSnapshot: true,
      productImageSnapshot: true,
      estimatedCostOfGoods: true,
      items: {
        select: { id: true, productId: true, productName: true, quantity: true, freeQuantity: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
    },
  });
  if (!from) throw new Error('BOX_NOT_FOUND');
  const lines = from.items as BoxLine[];
  const taken = takeFromBox(lines, box.pieces);
  const priced = priceTheBox({
    taken,
    paid: box.paid,
    fee: box.fee,
    priceIncludesDelivery: box.priceIncludesDelivery,
    minorUnit,
  });
  const first = taken[0].line;
  const sameProduct = first.productId === from.productId;
  // The pieces the customer was handed, by product: a product with a FIXED figure costs the figure × its pieces whatever the
  // box was struck at (the owner, 1/11: «ثابت لكل الطلبات»); the rest keep their share, below.
  const figures = await fixedCostsOf(tx, companyId, [...new Set(taken.map((t) => t.line.productId))]);
  return {
    priced,
    // The goods are the box's: its first product, named as the box named it.
    goods: {
      productId: first.productId,
      productNameSnapshot: sameProduct ? (from.productNameSnapshot ?? first.productName) : first.productName,
      productImageSnapshot: sameProduct ? from.productImageSnapshot : null,
      // Cost follows the pieces: the same units at the box's own average — and a fixed figure on top, where the product has one.
      estimatedCostOfGoods: costOfACopy(
        roundMinor((Number(from.estimatedCostOfGoods) * box.pieces) / Math.max(1, boxUnits(lines)), minorUnit),
        taken.map((t) => ({ productId: t.line.productId, units: t.qty })),
        figures,
        minorUnit
      ),
    },
  };
}

/** The columns a box-born order has, whether it is created or an unshipped replacement is reshaped into it. */
function boxOrderColumns(
  box: BoxPlan,
  read: Awaited<ReturnType<typeof readAndPriceBox>>,
  deliveryProviderId: string | null
) {
  const { priced, goods } = read;
  return {
    productId: goods.productId,
    offerId: null,
    quantity: box.pieces,
    freeQuantity: 0,
    sellingPrice: priced.subtotal,
    discountAmount: 0,
    shippingCost: 0,
    totalAmount: priced.cod,
    deliveryFee: priced.fee,
    priceIncludesDelivery: box.priceIncludesDelivery,
    productNameSnapshot: goods.productNameSnapshot,
    productImageSnapshot: goods.productImageSnapshot,
    estimatedCostOfGoods: goods.estimatedCostOfGoods,
    // Born delivered: the statement is the proof, and its dates are the dates.
    status: 'DELIVERED',
    confirmationStatus: 'CONFIRMED',
    shippingStatus: 'DELIVERED',
    settlementStatus: 'NOT_APPLICABLE',
    shippedAt: box.shippedAt,
    deliveredAt: box.deliveredAt,
    deliveryProviderId,
    shippingBatchId: null,
  };
}

async function writeBoxLines(
  tx: Prisma.TransactionClient,
  companyId: string,
  orderId: string,
  priced: PricedBox
): Promise<void> {
  for (const l of priced.lines) {
    await tx.orderItem.create({
      data: {
        companyId,
        orderId,
        productId: l.line.productId,
        productName: l.line.productName,
        quantity: l.qty,
        freeQuantity: 0,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        discountShare: 0,
        addedStage: 'INTAKE',
      },
    });
  }
}

/** A NEW order made of a box: the customer and the sale's people from `order`, the goods and money from the box. */
async function createBoxReplacement(tx: Prisma.TransactionClient, plan: ReplacementPlan): Promise<ReplacementResult> {
  const { companyId, order } = plan;
  const box = plan.box!;
  const read = await readAndPriceBox(tx, companyId, plan.minorUnit, box);
  const refs = await orderRefFields(tx, companyId, plan.orderPrefix, plan.attempt);
  // The sale's names (people, campaign, page) — the same columns the ordinary replacement carries.
  const sale = carriedSale(order);
  const created = await tx.order.create({
    data: {
      companyId,
      countryId: order.countryId,
      storeId: order.storeId,
      regionId: order.regionId,
      ...refs,
      replacesOrderId: order.id,
      customerId: order.customerId,
      currency: order.currency,
      ...(plan.createdById ? { createdById: plan.createdById } : {}),
      ...sale,
      ...boxOrderColumns(box, read, plan.deliveryProviderId ?? null),
      source: order.source,
      customerNotes: order.customerNotes,
      internalNotes: plan.internalNotes,
      version: 1,
    },
    select: { id: true, orderNumber: true },
  });
  await writeBoxLines(tx, companyId, created.id, read.priced);
  await reserveOrderLines(tx, created.id, { allowNegativeStock: plan.allowNegativeStock });
  return { ...created, cod: read.priced.cod, fee: read.priced.fee };
}

/**
 * AN UNSHIPPED REPLACEMENT BECOMES THE SALE — instead of a second one being raised beside it.
 *
 * A reorder already raised «X_r» for the customer and it has not left the warehouse. The box that was handed
 * over is its goods now: its lines are replaced, its units released and taken again for the new lines, and it is
 * delivered. The write is conditional on the version it was read at, so a press that raced it finds it moved.
 */
export async function reshapeToBox(
  tx: Prisma.TransactionClient,
  p: {
    companyId: string;
    orderId: string;
    expectedVersion: number;
    minorUnit: number;
    allowNegativeStock: boolean;
    deliveryProviderId: string | null;
    box: BoxPlan;
    internalNote: string;
  }
): Promise<ReplacementResult> {
  const read = await readAndPriceBox(tx, p.companyId, p.minorUnit, p.box);
  await releaseOrderLines(tx, p.orderId);
  await tx.orderItem.deleteMany({ where: { orderId: p.orderId } });
  await writeBoxLines(tx, p.companyId, p.orderId, read.priced);
  const moved = await tx.order.updateMany({
    where: { id: p.orderId, companyId: p.companyId, version: p.expectedVersion },
    data: {
      ...boxOrderColumns(p.box, read, p.deliveryProviderId),
      internalNotes: p.internalNote,
      version: { increment: 1 },
    },
  });
  if (moved.count !== 1) throw new BoxOrderMoved();
  await reserveOrderLines(tx, p.orderId, { allowNegativeStock: p.allowNegativeStock });
  const row = await tx.order.findFirst({
    where: { id: p.orderId, companyId: p.companyId },
    select: { id: true, orderNumber: true },
  });
  if (!row) throw new BoxOrderMoved();
  return { ...row, cod: read.priced.cod, fee: read.priced.fee };
}

export async function createReplacement(
  tx: Prisma.TransactionClient,
  plan: ReplacementPlan
): Promise<ReplacementResult> {
  // A box handed to the wrong customer is a different kind of order: delivered, priced by what was paid.
  if (plan.box) return createBoxReplacement(tx, plan);

  const { companyId, order, overrides } = plan;
  const items = await tx.orderItem.findMany({ where: { orderId: order.id } });

  /**
   * THE MONEY, THROUGH THE ONE COD FUNCTION.
   *
   * Unchanged goods keep the original's figures exactly — recomputing an
   * amount nobody asked to change is a way to move it by a rounding rule
   * that has shifted since. Changed goods go through `computeCod`, which
   * is the function every screen and service calls (contract PART 5), with
   * the order's own lines scaled to the approved quantity.
   *
   * The delivery fee is zero on a replacement, as the transfer path has it:
   * the fee for the leg already flown is owed against the ORIGINAL, and
   * this one is priced when it joins a shipment.
   */
  const changed =
    overrides !== undefined &&
    (overrides.quantity !== undefined || overrides.discountAmount !== undefined);

  const quantity = overrides?.quantity ?? order.quantity;
  const discount = overrides?.discountAmount ?? order.discountAmount;

  // Scale each line by the same factor the order's own quantity moved by,
  // so a two-line order stays a two-line order at the new count.
  const factor = order.quantity > 0 ? quantity / order.quantity : 1;
  const scaled = items.map((item) => {
    /**
     * `unitPrice` IS PER UNIT, AND MEASURED TO BE SURE.
     *
     * The order route writes it as `line.unitPrice / line.quantity` — it
     * divides because ITS input is a line total off the request body, not
     * because the column holds one. A real row: 3 × 16.67, lineTotal 50.
     * Dividing again here priced a replacement of two units at 11.11
     * instead of 33.34 — a third of the money, on an order the customer
     * still owes in full.
     */
    const unit = Number(item.unitPrice);
    const qty = changed ? Math.max(1, Math.round(item.quantity * factor)) : item.quantity;
    return { item, qty, unit };
  });

  const money = changed
    ? computeCod({
        lines: scaled.map((l) => ({ quantity: l.qty, unitPrice: l.unit })),
        discount,
        deliveryFee: 0,
        priceIncludesDelivery: order.priceIncludesDelivery === true,
        minorUnit: plan.minorUnit,
      })
    : null;

  /*
   * COST OF GOODS FOLLOWS THE COUNT: the same units at the same average — and a FIXED FIGURE on top (the owner, 1/11: «ثابت لكل
   * الطلبات»). The replacement is a new order costed now, so a line whose product has a figure costs the figure × the units it
   * really carries (the gift included), whatever the order it replaces was struck at. A cost is stored per order, not per line,
   * so the lines with no figure keep their share of the scaled cost (`costOfACopy`); with no figure on any line the cost is
   * exactly what it always was. Rounded by the currency — `plan.minorUnit` is the same one the money above was computed with.
   */
  const figures = await fixedCostsOf(tx, companyId, [...new Set(scaled.map((l) => l.item.productId))]);
  const carriedCost = costOfACopy(
    changed ? roundMinor(order.estimatedCostOfGoods * factor, plan.minorUnit) : order.estimatedCostOfGoods,
    scaled.map((l) => ({ productId: l.item.productId, units: l.qty + l.item.freeQuantity })),
    figures,
    plan.minorUnit
  );

  const refs = await orderRefFields(tx, companyId, plan.orderPrefix, plan.attempt);
  const replacement = await tx.order.create({
    data: {
      companyId,
      countryId: order.countryId,
      storeId: order.storeId,
      regionId: order.regionId,
      ...refs,
      replacesOrderId: order.id,
      customerId: order.customerId,
      productId: order.productId,
      offerId: order.offerId,
      quantity,
      freeQuantity: order.freeQuantity,
      sellingPrice: money ? money.subtotal : order.sellingPrice,
      discountAmount: discount,
      shippingCost: 0,
      totalAmount: money ? money.cod : order.totalAmount,
      currency: order.currency,
      priceIncludesDelivery: order.priceIncludesDelivery ?? undefined,
      productNameSnapshot: order.productNameSnapshot,
      productImageSnapshot: order.productImageSnapshot,
      ...(plan.createdById ? { createdById: plan.createdById } : {}),
      // The sale's name: moderator, confirmer, assignee, campaign, page.
      ...carriedSale(order),
      // Cost of goods follows the count, and a fixed figure where the product has one — see `carriedCost` above.
      estimatedCostOfGoods: carriedCost,
      // Already confirmed once — it re-enters at preparation, not intake.
      status: 'CONFIRMED',
      confirmationStatus: 'CONFIRMED',
      shippingStatus: plan.shippingStatus,
      settlementStatus: 'NOT_APPLICABLE',
      deliveryProviderId: plan.deliveryProviderId ?? null,
      shippingBatchId: plan.shippingBatchId ?? null,
      source: order.source,
      customerNotes: order.customerNotes,
      internalNotes: plan.internalNotes,
      version: 1,
    },
    select: { id: true, orderNumber: true },
  });

  // Carry the lines over, so preparation and stock see the same goods.
  for (const [i, l] of scaled.entries()) {
    const { item, qty } = l;
    await tx.orderItem.create({
      data: {
        companyId,
        orderId: replacement.id,
        productId: item.productId,
        productName: item.productName,
        quantity: qty,
        freeQuantity: item.freeQuantity,
        unitPrice: l.unit,
        lineTotal: money ? money.lineTotals[i] : item.lineTotal,
        discountShare: money ? money.discountShares[i] : item.discountShare,
        addedStage: 'INTAKE',
      },
    });
  }

  /**
   * The goods for the replacement come off the shelf NOW, not when the
   * first company finally sends the parcel back. The customer is waiting on
   * this one, and a replacement that cannot be picked is not a replacement.
   * The original's units stay reserved against it until the return is
   * received — two reservations for one sale is the true position while two
   * parcels exist.
   */
  await reserveOrderLines(tx, replacement.id, { allowNegativeStock: plan.allowNegativeStock });

  return replacement;
}

/**
 * THE COLUMNS `ReplacementSource` IS READ FROM — one select, so a caller cannot forget one.
 *
 * `carriedSale` copies the sale's people and the campaign, and each of them is a column somebody has to ask the
 * database for. The swap reads its customer's order through this, and the reorder and the transfer hand over the
 * whole row, so the three agree on what a replacement is made of.
 */
export const REPLACEMENT_SOURCE_SELECT = {
  id: true,
  orderNumber: true,
  countryId: true,
  storeId: true,
  regionId: true,
  customerId: true,
  productId: true,
  offerId: true,
  quantity: true,
  freeQuantity: true,
  sellingPrice: true,
  discountAmount: true,
  shippingCost: true,
  totalAmount: true,
  currency: true,
  priceIncludesDelivery: true,
  productNameSnapshot: true,
  productImageSnapshot: true,
  moderatorId: true,
  estimatedCostOfGoods: true,
  source: true,
  customerNotes: true,
  channelId: true,
  campaignId: true,
  landingPageId: true,
  deviceClass: true,
  adId: true,
  adSourceType: true,
  refCode: true,
  refCodeAt: true,
  touchAt: true,
  pageId: true,
  wabaId: true,
  conversationRef: true,
  confirmedById: true,
  assignedToId: true,
  assignedAt: true,
} as const;
