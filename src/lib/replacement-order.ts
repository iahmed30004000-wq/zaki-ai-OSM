import type { Prisma } from '@prisma/client';
import { orderRefFields } from './order-ref';
import { reserveOrderLines } from './reservation';
import { computeCod, roundMinor } from './money';

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
 *   · `createdById`, `claimedById`, `currentOwnerId` — who entered it, who
 *     holds its confirmation and who handles it now are all facts about the
 *     old order's work; the replacement enters at preparation.
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
}

export interface ReplacementResult {
  id: string;
  orderNumber: string;
}

export async function createReplacement(
  tx: Prisma.TransactionClient,
  plan: ReplacementPlan
): Promise<ReplacementResult> {
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
      // The sale's name: moderator, confirmer, assignee, campaign, page.
      ...carriedSale(order),
      // Cost of goods follows the count: the same units at the same average.
      // Rounded by the currency — `plan.minorUnit` is the same one the
      // money above was computed with.
      estimatedCostOfGoods: changed
        ? roundMinor(order.estimatedCostOfGoods * factor, plan.minorUnit)
        : order.estimatedCostOfGoods,
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
