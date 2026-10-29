import QRCode from 'qrcode';
import type { Prisma } from '@prisma/client';
import { db } from './db';
import { codForOrder, resolveDeliveryFee } from './delivery-fees';
import { formatMoney } from './money';
import { placeLine } from './address';
import { formatPhoneNumber } from './phone';
import type { LabelBatch } from './labels';
import type { LabelView } from './label-sheet';
import { isAutomated, type ProviderLike } from './couriers';

/**
 * WHAT GOES ON A WAYBILL, AND WHICH ORDERS MAY HAVE ONE.
 *
 * The print route, the "printed" report and the token route all ask the
 * same two questions — may this order be printed, and what does its label
 * say — so they ask this file, once.
 */

/**
 * What the print door needs to know about a courier to tell «sent by API» from «sent by hand». Read here and decrypted
 * nowhere but inside `adapterFor`; it never reaches a label, a CSV or a response.
 */
export const COURIER_KIND_SELECT = {
  name: true, code: true, adapterCode: true, apiEnabled: true, apiConfig: true, apiCredentials: true,
} satisfies Prisma.DeliveryProviderSelect;

/** Everything a label reads, and nothing it does not. */
export const WAYBILL_SELECT = {
  id: true,
  orderNumber: true,
  merchantRef: true,
  trackingNumber: true,
  totalAmount: true,
  currency: true,
  confirmationStatus: true,
  shippingStatus: true,
  shippingBatchId: true,
  deliveryProviderId: true,
  regionId: true,
  priceIncludesDelivery: true,
  labelPrintedAt: true,
  createdAt: true,
  // The customer's own note is written for the delivery; internalNotes,
  // shippingNote and the order's note thread are staff talk and never leave
  // the building on a courier's document.
  customerNotes: true,
  customer: { select: { fullName: true, phone: true, rawPhone: true, altPhone: true, city: true, address: true } },
  region: { select: { name: true } },
  deliveryProvider: { select: COURIER_KIND_SELECT },
  items: { select: { productName: true, quantity: true, freeQuantity: true, unitPrice: true, discountShare: true } },
  // The upsell accepted on the thank-you page. It used to be missing from
  // the label, so the packer never put it in the box.
  addOns: { select: { productName: true, quantity: true, price: true } },
} satisfies Prisma.OrderSelect;

export type WaybillOrder = Prisma.OrderGetPayload<{ select: typeof WAYBILL_SELECT }>;

/**
 * The sentence the print door gives an order that has not been sent to its courier yet.
 *
 * «باركود الشحنة و ال QR تبعنا ضروري يظهر بالبوليصة»: the label draws the courier's barcode in the Code128 and our order
 * number in the QR. Printed BEFORE the courier answered, it carried our reference twice and no courier barcode — a label
 * the courier cannot scan, so the warehouse reached for the courier's own, which has no QR of ours.
 */
export const WAITING_FOR_BARCODE = 'رحّل الطلب للشركة أول، عشان يطلع باركود الشحنة على البوليصة';

const FINISHED = ['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED', 'CANCELLED'];

/**
 * Why this order may not be printed, or null when it may.
 *
 * Printing is a commitment: the label is the address the driver holds, so a
 * printed order is sealed and can no longer simply be cancelled. That is
 * right for a parcel on a shelf and wrong for an order nobody has confirmed
 * yet — which is exactly what any order could become, from the orders list,
 * with one click. Now only a confirmed order with a courier gets a label.
 */
export function printRefusal(order: {
  confirmationStatus: string;
  shippingStatus: string;
  deliveryProviderId: string | null;
  /** With `deliveryProvider`: decides whether the courier's barcode is still owed. Left out, the order prints as before. */
  trackingNumber?: string | null;
  deliveryProvider?: ProviderLike | null;
}): string | null {
  if (order.confirmationStatus !== 'CONFIRMED') return 'لم يُؤكَّد';
  if (FINISHED.includes(order.shippingStatus)) return 'مُغلق';
  // A waybill names the courier and carries its barcode; without one there
  // is no delivery fee either, so the amount printed could not be right.
  if (!order.deliveryProviderId) return 'بلا شركة شحن';
  // A courier we send to by API answers with the barcode the label must carry. A manual courier has none to wait for.
  if (!order.trackingNumber && order.deliveryProvider && isAutomated(order.deliveryProvider)) return WAITING_FOR_BARCODE;
  return null;
}

/**
 * The orders a token names, in the order they print.
 *
 * A selection prints in the order it was chosen; a batch in the order it
 * was filled. The old route had no order at all and printed in whatever
 * order the database returned — useless when matching paper to parcels on
 * a packing line.
 */
export async function loadWaybillOrders(
  batch: LabelBatch,
  scope: { companyId: string; storeId: string }
): Promise<WaybillOrder[]> {
  if (batch.batchId) {
    return db.order.findMany({
      where: { shippingBatchId: batch.batchId, ...scope },
      orderBy: { createdAt: 'asc' },
      select: WAYBILL_SELECT,
    });
  }
  const rows = await db.order.findMany({
    // Per-order authorisation: the token alone is never enough.
    where: { id: { in: batch.orderIds }, ...scope },
    select: WAYBILL_SELECT,
  });
  const rank = new Map(batch.orderIds.map((id, i) => [id, i]));
  return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/**
 * What the courier collects, as the label must print it.
 *
 * Once the order is in a shipping batch the amount is a snapshot and is
 * read as it is. Before that the stored total may not include the delivery
 * fee yet (public orders are saved without one), so it is computed exactly
 * as shipment creation will compute it — the same fee lookup and the one
 * COD function, add-ons included — and the label agrees with what the batch
 * will record.
 */
export async function waybillCod(order: WaybillOrder, minorUnit: number): Promise<number> {
  if (order.shippingBatchId || !order.deliveryProviderId) return Number(order.totalAmount ?? 0);
  const fee = await resolveDeliveryFee(db, {
    deliveryProviderId: order.deliveryProviderId,
    regionId: order.regionId,
    minorUnit,
  });
  return codForOrder({
    lines: order.items,
    addOns: order.addOns,
    deliveryFee: fee.fee,
    priceIncludesDelivery: order.priceIncludesDelivery,
    minorUnit,
  }).cod;
}

/** Our reference as a QR, with its four-module quiet zone. */
async function qrSvg(value: string): Promise<string> {
  return QRCode.toString(value, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
}

/**
 * THE SECOND NUMBER, AS A DRIVER DIALS IT.
 *
 * The storefront stores the second number canonical, its trunk zero stripped («0988777666» becomes «988777666»), and
 * there is no as-typed copy of it. The label printed it as stored, so the second line read a number nobody can dial.
 * It is written back in the store country's form — the same call the dispatch makes for the courier's API — and a
 * number already typed with its zero comes out unchanged. A store with no known country leaves it as it is.
 */
export function altPhoneForLabel(altPhone: string | null | undefined, countryCode?: string | null): string {
  return altPhone ? formatPhoneNumber(altPhone, countryCode) : '';
}

/** One order, as its label shows it. */
export async function toLabelView(order: WaybillOrder, minorUnit: number, countryCode?: string | null): Promise<LabelView> {
  const ref = order.merchantRef ?? order.orderNumber;
  const c = order.customer;
  const cod = await waybillCod(order, minorUnit);
  return {
    orderId: order.id,
    courier: order.deliveryProvider?.name ?? 'شركة الشحن',
    ref,
    courierCode: order.trackingNumber || ref,
    name: c.fullName,
    phones: [c.rawPhone || c.phone, altPhoneForLabel(c.altPhone, countryCode)].filter(Boolean),
    place: placeLine(order.region?.name, c.city, c.address),
    items: [
      ...order.items.map((i) => ({ name: i.productName, qty: i.quantity + i.freeQuantity })),
      ...order.addOns.map((a) => ({ name: a.productName, qty: a.quantity, addOn: true })),
    ],
    note: order.customerNotes?.trim() || null,
    // With the currency's decimals: «32.500 JOD», never the raw «32.5 JOD».
    cod: formatMoney(cod, order.currency, minorUnit),
    qrSvg: await qrSvg(ref),
  };
}

/**
 * A spreadsheet cell that cannot become a formula.
 *
 * The CSV goes into the courier's system and into Excel. A customer-typed
 * name beginning with "=" or "+" is a formula there; prefixing it with an
 * apostrophe keeps it text.
 */
export function csvCell(value: unknown): string {
  let v = String(value ?? '');
  // "=", "@", a tab or a return at the start is always a formula trigger.
  // "+" and "-" are too — but they also begin every international phone
  // number and every negative amount, and prefixing those would break the
  // courier's own import. So they are neutralised only when what follows is
  // not simply a number.
  const always = /^[=@\t\r]/.test(v);
  const signed = /^[+-]/.test(v) && !/^[+-][\d\s().-]*$/.test(v);
  if (always || signed) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}
