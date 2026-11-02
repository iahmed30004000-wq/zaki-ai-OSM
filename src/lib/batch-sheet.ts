import { altPhoneForLabel, waybillCod, type WaybillOrder } from './waybill';
import { placeLine } from './address';
import { roundMinor } from './money';
import type { Cell } from './xlsx-writer';

/**
 * THE ORDERS OF A SHIPPING BATCH AS A SPREADSHEET — for creating the parcels at the courier by hand.
 *
 * The waybill CSV refuses an order whose courier barcode has not come back yet, which is right for a label and wrong for
 * this: the sheet exists for the moment BEFORE the barcode, when the parcels still have to be made at the company's own
 * portal (the courier's API was down, the batch was closed before it was sent, or the courier is not connected at all).
 * So every order of the batch is listed, with or without a barcode, and the sheet carries exactly what the dispatch sends
 * the courier's API: the reference, the receiver, the phones, the place, the courier's own id for the governorate, what to
 * collect, what is in the box and the customer's note.
 *
 * It reads; it computes no money. «المبلغ المطلوب» is `waybillCod`, the figure the waybill prints and the dispatch sends.
 */

export const BATCH_SHEET_HEADER = [
  'رقم الطلب',
  'باركود الشركة',
  'اسم المستلم',
  'الهاتف',
  'هاتف إضافي',
  'المحافظة',
  'رمز المدينة عند الشركة',
  'العنوان',
  'المبلغ المطلوب',
  'العملة',
  'المحتويات',
  'ملاحظات الزبون',
] as const;

export async function batchSheetRows(
  orders: WaybillOrder[],
  ctx: {
    minorUnit: number;
    countryCode?: string | null;
    /**
     * The courier's own id for each governorate, by region id — the one typed on the fees screen
     * (`DeliveryFee.courierCityId`, unless the courier's list proves it is a Region Id), else the one in the courier's
     * own list (`couriers/city-id`, the same answer the dispatch gets).
     */
    cityIds: Map<string, number>;
  }
): Promise<Cell[][]> {
  const rows: Cell[][] = [];
  for (const o of orders) {
    const cod = await waybillCod(o, ctx.minorUnit);
    rows.push([
      o.merchantRef ?? o.orderNumber,
      o.trackingNumber ?? '',
      o.customer.fullName,
      // The number AS TYPED: a courier's portal dials it, and the normalised form can lose its leading zero.
      o.customer.rawPhone || o.customer.phone,
      altPhoneForLabel(o.customer.altPhone, ctx.countryCode),
      o.region?.name ?? o.customer.city,
      o.regionId ? (ctx.cityIds.get(o.regionId) ?? '') : '',
      placeLine(o.region?.name ?? o.customer.city, null, o.deliveryAddress ?? o.customer.address).replace(/^[^—]*—\s*/, ''),
      // A number cell, with the currency's own decimals: «32.5» stays 32.5, and a sum of the column adds up.
      roundMinor(cod, ctx.minorUnit),
      o.currency,
      [
        ...o.items.map((i) => `${i.productName} x${i.quantity + i.freeQuantity}`),
        ...o.addOns.map((a) => `${a.productName} x${a.quantity} (إضافة)`),
      ].join(' | '),
      o.customerNotes ?? '',
    ]);
  }
  return rows;
}
