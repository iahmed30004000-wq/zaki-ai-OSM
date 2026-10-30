import { db } from './db';
import { codForOrder, resolveDeliveryFee } from './delivery-fees';
import { claimingRowWhere } from './match-integrity';
import { totalsBeforeDiscount } from './money';
import { activeOffersFor, toOfferView } from './offers';
import {
  previewLineEdit,
  type OfferFact,
  type OrderEditFacts,
  type OrderEditPreview,
  type PreviewDraft,
  type StoredLine,
} from './order-line-edit';
import { handedToCourier } from './order-seal';
import { normalizePhoneNumber } from './phone';
import { isValidPhoneFor, phoneKeys } from './phone-rules';
import { availableStock } from './reservation';

/**
 * THE FACTS A PREVIEW OF AN ORDER EDIT STANDS ON — READ, NEVER WRITTEN.
 *
 * `order-line-edit.ts` judges a draft as pure functions; this is the one place that fetches what they judge. It
 * reads the order's lines, its accepted add-ons, the products and offers involved, the shelf, the trolley and the
 * courier statements — and every read is a `find`/`count`/`aggregate`. There is no create, update, delete, lock,
 * notification, audit row or activity row anywhere in it, and a test holds the database to that: any write method
 * on the client it is given fails the run.
 *
 * It asks the shelf with the same inputs `reserveOrderLines` uses — the order's OWN holding left out, and with no store
 * named, i.e. across the company — but NOT with the same question: this sums the order's units per product (and
 * subtracts the add-ons it accepted), where `reserveOrderLines` tests each line on its own against the whole shelf.
 * The preview is the stricter of the two, so it never promises what the apply would refuse for stock, and it may
 * refuse what the apply would let through. If two stores of one company ever keep separate shelves that is a
 * difference in `reserveOrderLines` itself, not something to paper over here (BACKLOG_P2: RV400).
 *
 * THE LINES' ORDER is made here and is deterministic (`createdAt`, then `id`), whatever order the database hands the
 * rows back in: rows written together share one `createdAt`, and the remainder of a discount lands on the first
 * largest line, so a random tie-break would move a minor unit between lines from one read to the next.
 */

/** The order columns this reads. `assertOrderAccess` hands over the whole row; this names what is used. */
export interface EditableOrderRow {
  id: string;
  countryId?: string | null;
  customerId: string;
  regionId?: string | null;
  deliveryProviderId?: string | null;
  confirmationStatus: string;
  shippingStatus: string;
  shippedAt?: Date | null;
  labelPrintedAt?: Date | null;
  trackingNumber?: string | null;
  courierSendStartedAt?: Date | null;
  settlementStatus: string;
  priceIncludesDelivery?: boolean | null;
  totalAmount: number;
  shippingCost?: number | null;
  deliveryFee?: number | null;
  discountAmount?: number | null;
  offerId?: string | null;
  version: number;
}

/** A shipping state after which an order's lines are history, not a draft. */
const SHIPPING_CLOSED = ['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED', 'CANCELLED'];

/** A settlement state in which the order's money is still ours to compute. Anything else was moved by a statement. */
const SETTLEMENT_OPEN = ['NOT_APPLICABLE', 'PENDING', 'PENDING_COLLECTION'];

/**
 * ONE ANSWER PER PRODUCT, A FEW AT A TIME. A draft may name twenty lines, and asking the offers and the shelf of each
 * one after the other made a preview — which the screen asks for at every pause in typing — twenty round trips in a
 * row. All at once would be twenty connections from one keystroke; five at a time is both.
 */
const AT_A_TIME = 5;
async function inChunks<T, R>(items: readonly T[], ask: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += AT_A_TIME) {
    out.push(...(await Promise.all(items.slice(i, i + AT_A_TIME).map(ask))));
  }
  return out;
}

export async function readOrderEditFacts(args: {
  order: EditableOrderRow;
  companyId: string;
  country: { code: string; minorUnit: number; allowNegativeStock: boolean };
  draft: PreviewDraft;
  now?: Date;
}): Promise<OrderEditFacts> {
  const { order, companyId, country, draft } = args;
  const now = args.now ?? new Date();
  const minorUnit = country.minorUnit;

  const rows = await db.orderItem.findMany({
    where: { orderId: order.id, companyId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      createdAt: true,
      productId: true,
      productName: true,
      quantity: true,
      freeQuantity: true,
      unitPrice: true,
      discountShare: true,
      lineTotal: true,
      reservedQty: true,
      deliveredQty: true,
      returnedQty: true,
    },
  });
  // Equal `createdAt` is the rule, not the exception (one `createMany`): the id settles it, the same way every time.
  const items = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const addOnRows = await db.orderAddOn.findMany({
    where: { orderId: order.id, companyId },
    select: { productId: true, quantity: true, price: true },
  });

  const discount = Number(order.discountAmount ?? 0);
  const before = totalsBeforeDiscount(items, discount, minorUnit);
  const lines: StoredLine[] = items.map((it, i) => ({
    id: it.id,
    productId: it.productId,
    productName: it.productName,
    quantity: it.quantity,
    freeQuantity: it.freeQuantity,
    lineTotal: before[i],
    reservedQty: it.reservedQty,
    deliveredQty: it.deliveredQty,
    returnedQty: it.returnedQty,
  }));
  const addOns = addOnRows.map((a) => ({ productId: a.productId, quantity: a.quantity, price: Number(a.price) }));

  // ── the products and the offers the draft could touch
  const productIds = [...new Set([...lines.map((l) => l.productId), ...(draft.lines ?? []).flatMap((e) => (e.productId ? [e.productId] : []))])];
  const orderOfferRow = order.offerId
    ? await db.offer.findFirst({
        where: { id: order.offerId, companyId },
        select: {
          id: true,
          productId: true,
          name: true,
          quantity: true,
          freeQuantity: true,
          sellingPrice: true,
          discount: true,
          compareAtPrice: true,
          isDefault: true,
          deliveryIncluded: true,
          endsAt: true,
        },
      })
    : null;
  const offerProductIds = [...new Set([...productIds, ...(orderOfferRow ? [orderOfferRow.productId] : [])])];

  const productRows = await db.product.findMany({
    where: { id: { in: productIds }, companyId },
    select: { id: true, name: true, basePrice: true, status: true },
  });
  const products = productRows.map((p) => ({ id: p.id, name: p.name, basePrice: Number(p.basePrice), status: p.status }));

  // What is on sale comes from the ONE query that decides it (`activeOffersFor`); "live" is whether it is in there.
  const offers: OfferFact[] = [];
  const viewsByProduct = await inChunks(offerProductIds, (productId) => activeOffersFor(db, companyId, productId, minorUnit, now));
  for (const [i, productId] of offerProductIds.entries()) {
    for (const v of viewsByProduct[i]) {
      offers.push({
        id: v.id,
        productId,
        name: v.name,
        quantity: v.quantity,
        freeQuantity: v.freeQuantity,
        listPrice: v.listPrice ?? v.price,
        price: v.price,
        live: true,
      });
    }
  }
  let orderOffer: OfferFact | null = null;
  if (orderOfferRow) {
    const live = offers.find((o) => o.id === orderOfferRow.id);
    if (live) orderOffer = live;
    else {
      const view = toOfferView(orderOfferRow, minorUnit);
      orderOffer = {
        id: orderOfferRow.id,
        productId: orderOfferRow.productId,
        name: orderOfferRow.name,
        quantity: orderOfferRow.quantity,
        freeQuantity: orderOfferRow.freeQuantity,
        listPrice: view.listPrice ?? view.price,
        price: view.price,
        live: false,
      };
    }
  }

  // ── the shelf, asked as `reserveOrderLines` asks it
  const stockIds = [...new Set([...lines.map((l) => l.productId), ...productIds])];
  const available: Record<string, number> = {};
  const counts = await inChunks(stockIds, (productId) => availableStock(db, companyId, productId, order.id));
  for (const [i, productId] of stockIds.entries()) available[productId] = counts[i];

  // ── where the parcel is, and who else already wrote the money
  const batch = await db.shippingBatch.findFirst({
    where: { orders: { some: { id: order.id } }, companyId },
    select: { status: true },
  });
  const handed = handedToCourier({
    shippingStatus: order.shippingStatus,
    shippedAt: order.shippedAt ?? null,
    batchStatus: batch?.status ?? null,
  });
  const claimed = await db.settlementMatch.count({
    where: { companyId, orderId: order.id, statementLineId: { not: null }, OR: claimingRowWhere() },
  });

  const closed = ['REJECTED', 'CANCELLED'].includes(order.confirmationStatus) || SHIPPING_CLOSED.includes(order.shippingStatus);
  const shippingCost = Number(order.shippingCost ?? 0);
  const deliveryFee = order.deliveryFee === null || order.deliveryFee === undefined ? null : Number(order.deliveryFee);
  const priceIncludesDelivery = order.priceIncludesDelivery === true;

  // The shipment calculator's reading of the stored lines — compared, never used for the preview's own figures.
  const shipmentCod =
    items.length === 0
      ? null
      : codForOrder({
          lines: items.map((it) => ({
            quantity: it.quantity,
            unitPrice: Number(it.unitPrice),
            freeQuantity: it.freeQuantity,
            discountShare: Number(it.discountShare),
            lineTotal: Number(it.lineTotal),
          })),
          addOns: addOnRows,
          deliveryFee: deliveryFee ?? shippingCost,
          priceIncludesDelivery,
          minorUnit,
        }).cod;

  // ── the customer's own fields, only if the draft carries them
  let phoneDuplicate = false;
  if (draft.customerPhone !== undefined) {
    const dupe = await db.customer.findFirst({
      where: {
        companyId,
        phone: { in: phoneKeys(normalizePhoneNumber(draft.customerPhone, country.code)) },
        id: { not: order.customerId },
      },
      select: { id: true },
    });
    phoneDuplicate = !!dupe;
  }
  let regionOutsideCountry = false;
  let regionFee: { current: number; next: number } | null = null;
  if (draft.regionId) {
    const region = await db.region.findFirst({
      where: { id: draft.regionId, countryId: order.countryId ?? undefined, isActive: true },
      select: { id: true },
    });
    regionOutsideCountry = !region;
    if (region && order.deliveryProviderId) {
      const table = await resolveDeliveryFee(db, { deliveryProviderId: order.deliveryProviderId, regionId: region.id, minorUnit });
      if (table.source === 'TABLE') regionFee = { current: deliveryFee ?? shippingCost, next: table.fee };
    }
  }

  return {
    minorUnit,
    allowNegativeStock: country.allowNegativeStock,
    order: {
      confirmed: order.confirmationStatus === 'CONFIRMED',
      closed,
      handed,
      labelled: !!(order.labelPrintedAt || order.trackingNumber || order.courierSendStartedAt),
      statementLinked: claimed > 0 || !SETTLEMENT_OPEN.includes(order.settlementStatus),
      priceIncludesDelivery,
      storedTotal: Number(order.totalAmount),
      shippingCost,
      deliveryFee,
      discount,
      version: order.version,
    },
    lines,
    addOns,
    products,
    offers,
    orderOffer,
    available,
    shipmentCod,
    customer: {
      phoneInvalid: draft.customerPhone !== undefined && !isValidPhoneFor(country.code, draft.customerPhone),
      altPhoneInvalid: !!draft.customerAltPhone && !isValidPhoneFor(country.code, draft.customerAltPhone),
      phoneDuplicate,
      regionOutsideCountry,
      regionFee,
    },
  };
}

/**
 * The preview of a draft against an order: read the facts, judge them. Writes nothing.
 */
export async function previewOrderEdit(args: Parameters<typeof readOrderEditFacts>[0]): Promise<OrderEditPreview> {
  const facts = await readOrderEditFacts(args);
  return previewLineEdit(facts, args.draft);
}
