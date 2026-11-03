import { db } from './db';
import { altPhoneForLabel, waybillCod, type WaybillOrder } from './waybill';
import { cityIdsForRegions, storedCityIds } from './couriers/city-id';
import type { CourierIdentity } from './couriers/places';
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

/**
 * The courier's own id for each governorate of these orders: the same answer the dispatch gets for the API
 * (`couriers/city-id`) — the id typed on the fees screen, else the one in the courier's own list. The typed ones are read
 * once. Lifted out of the batch's Excel door (3/11) so the file of the ready orders asks it the same way.
 */
export async function sheetCityIds(
  courier: { id: string | null; identity: CourierIdentity | null | undefined },
  orders: readonly { regionId: string | null; region?: { name: string } | null }[]
): Promise<Map<string, number>> {
  const typedCityIds = storedCityIds(
    courier.id
      ? await db.deliveryFee.findMany({
          where: { deliveryProviderId: courier.id, courierCityId: { not: null } },
          select: { regionId: true, courierCityId: true },
        })
      : []
  );
  return cityIdsForRegions({
    provider: courier.identity,
    stored: typedCityIds,
    regions: orders.map((o) => ({ id: o.regionId, name: o.region?.name })),
  });
}

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
    /**
     * A sheet for sharing the orders out between couriers, before any courier is chosen (the owner, 3/11: «الهدف اسحب
     * الطلبات فقط اوزع المناطق ع شركات الشحن»): no money at all. «المبلغ المطلوب» and «العملة» are left empty and nothing
     * is read or worked out for them. Absent, the sheet is exactly what it always was.
     */
    withoutMoney?: boolean;
  }
): Promise<Cell[][]> {
  const rows: Cell[][] = [];
  for (const o of orders) {
    const cod = ctx.withoutMoney ? null : await waybillCod(o, ctx.minorUnit);
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
      cod === null ? '' : roundMinor(cod, ctx.minorUnit),
      cod === null ? '' : o.currency,
      [
        ...o.items.map((i) => `${i.productName} x${i.quantity + i.freeQuantity}`),
        ...o.addOns.map((a) => `${a.productName} x${a.quantity} (إضافة)`),
      ].join(' | '),
      o.customerNotes ?? '',
    ]);
  }
  return rows;
}
